package com.shilapi.xcertplay

import android.content.Context
import android.graphics.Point
import android.os.Build
import android.view.WindowManager
import com.shilapi.xcertplay.airplay.SafeAreaRect
import com.shilapi.xcertplay.i18n.*
import com.shilapi.xcertplay.shared.R as UiR
import kotlin.math.roundToInt

enum class CarPlayAppearance(@param:androidx.annotation.StringRes val labelRes: Int) {
    /**
     * Follows whichever device is showing the picture right now: the Android system theme while
     * CarPlay is displayed on this device, the head-unit browser's own light/dark preference while
     * it is streamed to the browser. [night] falls back to the Android value until a browser has
     * reported one, so a head unit that never sends the media query result behaves exactly like a
     * plain follow-Android choice instead of locking CarPlay to one appearance.
     */
    FOLLOW_DISPLAY(UiR.string.ui_follow_display),
    DAY(UiR.string.ui_always_day),
    NIGHT(UiR.string.ui_always_night);

    fun night(systemNight: Boolean, browserNight: Boolean?, localDisplay: Boolean): Boolean =
        when (this) {
            FOLLOW_DISPLAY -> if (localDisplay) systemNight else browserNight ?: systemNight
            DAY -> false
            NIGHT -> true
        }
}

enum class CarPlayMicrophoneSource(@param:androidx.annotation.StringRes val labelRes: Int) {
    ANDROID(UiR.string.ui_android_microphone),
    BROWSER(UiR.string.ui_browser_microphone),
    DISABLED(UiR.string.ui_disable_microphone),
}

enum class CarPlayAudioOutput(@param:androidx.annotation.StringRes val labelRes: Int) {
    ANDROID(UiR.string.ui_android_device),
    BROWSER(UiR.string.ui_head_unit_browser),
}

/** Where CarPlay goes once the iPhone connects: stream to the head-unit browser or show on this phone. */
enum class CarPlayDefaultView(@param:androidx.annotation.StringRes val labelRes: Int) {
    BROWSER_STREAM(UiR.string.ui_default_stream_to_browser),
    PHONE_DISPLAY(UiR.string.ui_default_show_on_phone),
}

/**
 * The phone panel expressed the way a head-unit browser reports its viewport: landscape logical (dp)
 * pixels. Recorded into the default display size when the on-phone view is chosen, so the auto-connect
 * session negotiates the phone's own canvas from the start and the preview never triggers a reconnect.
 * Returns null when the dp size is outside the CarPlay canvas limits.
 */
object CarPlayPhoneDisplay {
    // The largest canvas CarPlay negotiates today (scheduleBrowserDisplaySize caps a reported browser
    // viewport to the same box), so a phone-derived canvas can never exceed what the pipeline accepts.
    private const val MAX_CANVAS_WIDTH = 3840
    private const val MAX_CANVAS_HEIGHT = 2160

    fun landscapeDp(context: Context): Pair<Int, Int>? {
        val density = context.resources.displayMetrics.density.takeIf { it >= 1f } ?: 1f
        val panel = fullPanelPx(context)
        val longEdge = even(maxOf(panel.x, panel.y) / density)
        val shortEdge = even(minOf(panel.x, panel.y) / density)
        if (longEdge < 320 || shortEdge < 320) return null
        if (longEdge.toDouble() / shortEdge > 4.0) return null
        return longEdge to shortEdge
    }

    /** The phone panel in physical pixels: the dp canvas scaled back by density, so dp→px only changes size, never proportion. */
    fun landscapePx(context: Context): Pair<Int, Int>? =
        landscapeDp(context)?.let { landscapePx(it.first, it.second, context.resources.displayMetrics.density) }

    /**
     * Expands a recorded dp canvas to physical pixels (dp * density, even, capped to the 3840x2160
     * maximum the negotiation pipeline accepts). Used for the on-phone display, where the canvas
     * should match the panel 1:1 instead of being upscaled by density. Null when the result leaves
     * the CarPlay canvas limits.
     */
    fun landscapePx(dpWidth: Int, dpHeight: Int, density: Float): Pair<Int, Int>? {
        if (dpWidth <= 0 || dpHeight <= 0) return null
        val scale = density.takeIf { it >= 1f } ?: 1f
        var longEdge = (maxOf(dpWidth, dpHeight) * scale).toDouble()
        var shortEdge = (minOf(dpWidth, dpHeight) * scale).toDouble()
        val fit = minOf(1.0, MAX_CANVAS_WIDTH / longEdge, MAX_CANVAS_HEIGHT / shortEdge)
        longEdge *= fit
        shortEdge *= fit
        val longPx = even(longEdge)
        val shortPx = even(shortEdge)
        if (longPx < 320 || shortPx < 320) return null
        return longPx to shortPx
    }

    private fun even(value: Float): Int = even(value.toDouble())

    private fun even(value: Double): Int = (value.roundToInt().coerceAtLeast(2) / 2) * 2

    /**
     * The canvas a default (no reported browser viewport) negotiation starts at. The physical-pixel
     * twin applies only while the picture is meant for the phone: either no head-unit browser viewer
     * is watching, or the local preview already owns the canvas. With a watching browser the recorded
     * dp size is kept, so the web stream gets exactly the canvas it used before the 1:1 expansion -
     * the px twin must never leak into a browser session. A null recorded pair leaves the caller's
     * own browser default (returned as null here).
     */
    fun selectDefaultDisplayPair(
        recorded: Pair<Int, Int>?,
        pxTwin: Pair<Int, Int>?,
        hasBrowserViewer: Boolean,
        localDisplayActive: Boolean,
    ): Pair<Int, Int>? {
        if (recorded == null) return null
        if (hasBrowserViewer && !localDisplayActive) return recorded
        return pxTwin ?: recorded
    }

    @Suppress("DEPRECATION")
    private fun fullPanelPx(context: Context): Point {
        val manager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            val bounds = manager.maximumWindowMetrics.bounds
            Point(bounds.width(), bounds.height())
        } else {
            Point().also { manager.defaultDisplay.getRealSize(it) }
        }
    }
}

enum class BrowserOfflinePolicy(
    @param:androidx.annotation.StringRes val labelRes: Int,
    val timeoutMillis: Long?,
) {
    KEEP(UiR.string.ui_keep_carplay_connected, null),
    ONE_MINUTE(UiR.string.ui_disconnect_iphone_after_1_minute_offline, 60_000),
    FIVE_MINUTES(UiR.string.ui_disconnect_iphone_after_5_minutes_offline, 300_000),
}

/** Percentages follow the negotiated display size, including adaptive browser resolutions. */
data class CarPlaySafeMargins(
    val top: Int = 0,
    val bottom: Int = 0,
    val left: Int = 0,
    val right: Int = 0,
) {
    init {
        requireUi(listOf(top, bottom, left, right).all { it in 0..40 }) {
            UiText(UiR.string.ui_each_margin_must_be_between_0_and_40)
        }
    }

    val isFullScreen
        get() = top == 0 && bottom == 0 && left == 0 && right == 0

    fun rectangle(width: Int, height: Int): SafeAreaRect? {
        require(width > 0 && height > 0)
        if (isFullScreen) return null
        val x = (width * left / 100.0).roundToInt().coerceIn(0, width - 1)
        val y = (height * top / 100.0).roundToInt().coerceIn(0, height - 1)
        return SafeAreaRect(
            x,
            y,
            (width * (100 - right) / 100.0).roundToInt().coerceIn(x + 1, width),
            (height * (100 - bottom) / 100.0).roundToInt().coerceIn(y + 1, height),
        )
    }

    fun encode() = "$top,$bottom,$left,$right"

    companion object {
        fun decode(value: String?): CarPlaySafeMargins? =
            runCatching {
                    val parts = value?.split(',') ?: return null
                    if (parts.size != 4) return null
                    CarPlaySafeMargins(
                        parts[0].toInt(),
                        parts[1].toInt(),
                        parts[2].toInt(),
                        parts[3].toInt(),
                    )
                }
                .getOrNull()
    }
}
