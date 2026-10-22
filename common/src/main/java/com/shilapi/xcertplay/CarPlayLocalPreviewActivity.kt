// SPDX-License-Identifier: AGPL-3.0-only
package com.shilapi.xcertplay

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.shilapi.xcertplay.media.AndroidMediaSink
import com.shilapi.xcertplay.media.CarPlayTouchMapper
import com.shilapi.xcertplay.media.CarPlayVideoLayout
import com.shilapi.xcertplay.shared.R as UiR
import com.shilapi.xcertplay.web.WebSession

/**
 * Shows the live CarPlay picture on this phone. Entering pauses the browser stream and its touch
 * and - when adaptive sizing is on - re-negotiates the canvas to the phone's landscape aspect. The
 * video is drawn with an aspect-preserving fit (a [TextureView] transform), and touch is mapped
 * through that same content rectangle - the mechanism the upstream DiPlay host uses - so the
 * picture is never stretched and every control, including the dock, lands where it is drawn.
 */
class CarPlayLocalPreviewActivity : ComponentActivity() {
    private companion object {
        // The main CarPlay screen; matches CarPlayHostActivity.SCREEN_TYPE_MAIN.
        const val SCREEN_TYPE_MAIN = 110
    }

    private var videoView: TextureView? = null
    private var attachedSurface: Surface? = null
    private var attachedSink: AndroidMediaSink? = null
    private var sessionSubscription: AutoCloseable? = null
    private var loadingOverlay: View? = null
    private var touchOutsideContent = false
    private var lastNightMode: Boolean? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        window.attributes = window.attributes.apply {
            layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        goImmersive()
        val snapshot = CarPlayBackgroundSession.snapshot()
        if (snapshot == null) {
            setContentView(TextView(this).apply {
                text = getString(UiR.string.ui_local_display_no_session)
                textSize = 18f
                setTextColor(Color.WHITE)
                setBackgroundColor(Color.BLACK)
                gravity = Gravity.CENTER
                setPadding(dp(24), dp(24), dp(24), dp(24))
            })
            return
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val view = TextureView(this).also { videoView = it }
        view.isOpaque = true
        view.setOnTouchListener { target, event -> forwardTouch(event, target.width, target.height) }
        view.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
                attachLocalDisplay(Surface(texture))
                applyVideoTransform(width, height)
            }

            override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) =
                applyVideoTransform(width, height)

            override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
                detachLocalDisplay()
                return true
            }

            override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {
                // A decoded frame just rendered; drop the loading hint.
                if (loadingOverlay?.visibility == View.VISIBLE) loadingOverlay?.visibility = View.GONE
            }
        }
        val container = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(view, FrameLayout.LayoutParams(-1, -1))
        }
        loadingOverlay = buildLoadingOverlay().also { container.addView(it, FrameLayout.LayoutParams(-1, -1)) }
        setContentView(container)
        // Fill the whole panel (reclaim the top/left safe area). The aspect-preserving fit plus the
        // content-rect touch mapping keep every control aligned even where it meets the screen edge.
        view.post { startLocalDisplayFromSize() }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = finish()
        })
        // An adaptive reconnect rebuilds the sink; re-attach the surface and refresh the fit.
        sessionSubscription = CarPlayBackgroundSession.subscribe { update ->
            runOnUiThread {
                reattachToSink(update?.sink)
                videoView?.let { applyVideoTransform(it.width, it.height) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        // This preview is the foreground screen while CarPlay is shown on the phone, so it owns the
        // follow-Android push: the host activity is stopped behind here and would not receive a live
        // onConfigurationChanged. Re-apply the current theme on entry (it may have moved while this
        // screen was paused) and keep lastNightMode as the dedup baseline for later flips.
        lastNightMode = isDarkMode(resources.configuration.uiMode)
        WebSession.refreshAppearance(this, lastNightMode == true)
        goImmersive()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        val night = isDarkMode(newConfig.uiMode)
        if (night != lastNightMode) {
            lastNightMode = night
            WebSession.refreshAppearance(this, night)
        }
        goImmersive()
    }

    override fun onDestroy() {
        WebSession.endLocalDisplay()
        sessionSubscription?.close()
        sessionSubscription = null
        detachLocalDisplay()
        super.onDestroy()
    }

    private fun goImmersive() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    private fun buildLoadingOverlay(): View = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
        setBackgroundColor(0xCC000000.toInt())
        isClickable = false
        isFocusable = false
        addView(ProgressBar(context))
        addView(
            TextView(context).apply {
                text = getString(UiR.string.ui_local_display_connecting)
                setTextColor(Color.WHITE)
                textSize = 16f
                setPadding(0, dp(16), 0, 0)
            },
            LinearLayout.LayoutParams(-2, -2),
        )
    }

    /** The rectangle the video actually occupies inside the view, matching the render transform. */
    private fun contentRect(viewWidth: Int, viewHeight: Int): CarPlayVideoLayout {
        val sink = CarPlayBackgroundSession.snapshot()?.sink ?: return CarPlayVideoLayout(0f, 0f, viewWidth.toFloat(), viewHeight.toFloat())
        val intrinsic = sink.localDisplayIntrinsicSize(SCREEN_TYPE_MAIN)
        val width = intrinsic?.first ?: sink.localDisplayWidth
        val height = intrinsic?.second ?: sink.localDisplayHeight
        return CarPlayVideoLayout.fit(width, height, viewWidth, viewHeight)
    }

    private fun applyVideoTransform(viewWidth: Int, viewHeight: Int) {
        val view = videoView ?: return
        if (viewWidth <= 0 || viewHeight <= 0) return
        val content = contentRect(viewWidth, viewHeight)
        view.setTransform(Matrix().apply {
            setScale(content.width / viewWidth, content.height / viewHeight)
            postTranslate(content.left, content.top)
        })
        loadingOverlay?.visibility = if (WebSession.videoActive) View.GONE else View.VISIBLE
    }

    private fun forwardTouch(event: MotionEvent, viewWidth: Int, viewHeight: Int): Boolean {
        val controller = CarPlayBackgroundSession.snapshot()?.controller ?: return false
        val content = contentRect(viewWidth, viewHeight)
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            touchOutsideContent = !content.contains(event.x, event.y)
        }
        if (touchOutsideContent) {
            // Ignore a whole gesture that began in a letterbox bar; forwarding a lone release would
            // create a phantom tap inside CarPlay.
            if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
                touchOutsideContent = false
            }
            return true
        }
        controller.sendTouch(CarPlayTouchMapper.contacts(event, content))
        return true
    }

    private fun startLocalDisplayFromSize() {
        // The preview always asks for the phone's own physical-pixel canvas: the recorded dp size
        // scaled by density (same proportion, capped to 3840x2160), so the panel renders 1:1 instead
        // of a density upscale. The host's default-display fallback applies the identical expansion
        // while localDisplayActive, so in on-phone view entering still changes nothing; in
        // browser+adaptive view the session sits at the head-unit viewport, so this correctly
        // reconnects to render on the phone. Falls back to the live view box only when the px size
        // is unusable.
        val phone = CarPlayPhoneDisplay.landscapePx(this)
        if (phone != null) {
            WebSession.beginLocalDisplay(phone.first, phone.second)
            return
        }
        val view = videoView ?: return
        if (view.width <= 0 || view.height <= 0) {
            view.post { startLocalDisplayFromSize() }
            return
        }
        WebSession.beginLocalDisplay(view.width, view.height)
    }

    private fun attachLocalDisplay(surface: Surface) {
        attachedSurface?.release()
        attachedSurface = surface
        val sink = CarPlayBackgroundSession.snapshot()?.sink ?: return
        attachedSink = sink
        sink.requestLocalDisplay(SCREEN_TYPE_MAIN, surface)
    }

    private fun detachLocalDisplay() {
        val surface = attachedSurface ?: return
        attachedSink?.releaseLocalDisplay(SCREEN_TYPE_MAIN, surface)
        attachedSurface = null
    }

    private fun reattachToSink(sink: AndroidMediaSink?) {
        if (sink === attachedSink) return
        val surface = attachedSurface
        attachedSink?.let { old -> if (surface != null) old.releaseLocalDisplay(SCREEN_TYPE_MAIN, surface) }
        attachedSink = sink
        if (sink != null && surface != null) sink.requestLocalDisplay(SCREEN_TYPE_MAIN, surface)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
