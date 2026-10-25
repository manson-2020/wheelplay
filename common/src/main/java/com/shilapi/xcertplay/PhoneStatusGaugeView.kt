// SPDX-License-Identifier: AGPL-3.0-only
package com.shilapi.xcertplay

import android.animation.ValueAnimator
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.view.animation.PathInterpolator
import androidx.core.content.ContextCompat
import com.shilapi.xcertplay.web.PhoneStatus
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * The same circular gauge the browser floats over the head-unit picture, drawn with Canvas for the
 * on-phone preview: that screen is a [android.view.TextureView] fed straight from the decoder, so the
 * HTML badge has nothing to attach to. Values, geometry and colours mirror `phoneGaugeValues` and
 * `phoneStatusMarkup` in common/src/main/assets/web/app.js - keep the two in step when the design moves.
 *
 * It is a small view rather than part of the picture, so a drag moves only this view and every touch
 * outside it still reaches CarPlay.
 */
class PhoneStatusGaugeView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    private val density = resources.displayMetrics.density
    // The browser draws its SVG inside an 88 px disc with a 1 px border and 2 px padding, so the
    // viewBox never touches the disc edge. Both insets stay fixed in px/dp while the disc scales.
    private val discInset = (DISC_EDGE_DP + DISC_PADDING_DP) * density

    private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val markPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val glassPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = GLASS
    }
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = DISC_EDGE_DP * density
        color = DISC_EDGE
    }
    private val numberPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }
    private val box = RectF()

    private var values: PhoneStatus.Snapshot? = null
    private var batteryOffset = PhoneGaugeGeometry.EMPTY_OFFSET
    private var volumeOffset = PhoneGaugeGeometry.EMPTY_OFFSET
    private var batteryColor = INK
    private var sweep: ValueAnimator? = null

    private val handler = Handler(Looper.getMainLooper())
    private val poll = object : Runnable {
        override fun run() {
            apply(PhoneStatus.snapshot(context))
            handler.postDelayed(this, POLL_MILLIS)
        }
    }

    // A cable in or out moves no arc - it only changes the battery colour - and the reading itself is
    // cached, so the plug events repaint from a fresh snapshot instead of waiting the cache out.
    private val power = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            apply(PhoneStatus.refresh(context))
        }
    }

    // Dragging mirrors the browser badge: a short drag moves the gauge, a double tap restores the
    // corner. Touches that miss the gauge never reach this view, so CarPlay keeps the rest.
    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDoubleTap(event: MotionEvent): Boolean {
            resetPosition()
            performClick()
            return true
        }
    })
    private var dragStartX = 0f
    private var dragStartY = 0f
    private var dragOriginX = 0f
    private var dragOriginY = 0f
    private var dragging = false
    private var positionRestored = false

    init {
        // Clickable so a drag is delivered here instead of falling through to the CarPlay surface.
        isClickable = true
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        val plugs = IntentFilter().apply {
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        }
        ContextCompat.registerReceiver(context, power, plugs, ContextCompat.RECEIVER_NOT_EXPORTED)
        // Paint the reading of this moment instead of the one left in the cache by whoever saw it last.
        apply(PhoneStatus.refresh(context), animate = false)
        handler.postDelayed(poll, POLL_MILLIS)
        post { restorePosition() }
    }

    override fun onDetachedFromWindow() {
        handler.removeCallbacks(poll)
        runCatching { context.unregisterReceiver(power) }
        sweep?.cancel()
        sweep = null
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        clampInsideParent()
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        gestures.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragStartX = event.rawX
                dragStartY = event.rawY
                dragOriginX = translationX
                dragOriginY = translationY
                dragging = false
                return true
            }

            MotionEvent.ACTION_MOVE -> {
                // A tap that jitters a few pixels must not slide the gauge.
                val dx = event.rawX - dragStartX
                val dy = event.rawY - dragStartY
                if (!dragging && hypot(dx, dy) < DRAG_SLOP_DP * density) return true
                dragging = true
                translationX = dragOriginX + dx
                translationY = dragOriginY + dy
                clampInsideParent()
                return true
            }

            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (dragging) AirPlayPersistence.savePhoneStatusBadgeOffset(context, translationX, translationY)
                dragging = false
                return true
            }
        }
        return true
    }

    private fun clampInsideParent() {
        val parentView = parent as? View ?: return
        if (parentView.width <= 0 || parentView.height <= 0 || width <= 0 || height <= 0) return
        val minX = -left.toFloat()
        val maxX = (parentView.width - width - left).toFloat().coerceAtLeast(minX)
        val minY = -top.toFloat()
        val maxY = (parentView.height - height - top).toFloat().coerceAtLeast(minY)
        translationX = translationX.coerceIn(minX, maxX)
        translationY = translationY.coerceIn(minY, maxY)
    }

    private fun restorePosition() {
        if (positionRestored) return
        positionRestored = true
        val saved = AirPlayPersistence.loadPhoneStatusBadgeOffset(context)
        if (saved != null) {
            translationX = saved.first
            translationY = saved.second
        }
        clampInsideParent()
    }

    private fun resetPosition() {
        translationX = 0f
        translationY = 0f
        AirPlayPersistence.savePhoneStatusBadgeOffset(context, 0f, 0f)
    }

    /** The phone's own reading, or null when nothing is readable and the gauge must stay away. */
    internal fun apply(next: PhoneStatus.Snapshot?, animate: Boolean = true) {
        val previous = values
        values = next
        if (next == null || !PhoneGaugeGeometry.showsGauge(next)) {
            sweep?.cancel()
            sweep = null
            visibility = INVISIBLE
            return
        }
        visibility = VISIBLE
        // Only the battery reading leaves the neutral ink: green while the phone charges, red under the
        // threshold - charging outranks the warning.
        batteryColor = when {
            next.charging -> CHARGING
            next.battery in 0 until PhoneStatus.LOW_BATTERY_PERCENT -> LOW
            else -> INK
        }
        val targetBattery = PhoneGaugeGeometry.dashOffset(next.battery)
        val targetVolume = PhoneGaugeGeometry.dashOffset(next.volume)
        if (targetBattery == batteryOffset && targetVolume == volumeOffset) {
            // Neither arc moves, but the numbers, the colour the plug state drives or the transport icon
            // may still have changed: they live in the reading, and only a repaint puts them on glass.
            if (previous != next) invalidate()
            return
        }
        if (!animate) {
            sweep?.cancel()
            sweep = null
            batteryOffset = targetBattery
            volumeOffset = targetVolume
            invalidate()
            return
        }
        // The browser lets CSS interpolate the dash offset over 700 ms; here the same easing runs the
        // arcs by hand so a reading that changes every couple of seconds sweeps instead of flicking.
        sweep?.cancel()
        val fromBattery = batteryOffset
        val fromVolume = volumeOffset
        sweep = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = SWEEP_MILLIS
            interpolator = PathInterpolator(0.22f, 1f, 0.36f, 1f)
            addUpdateListener { animation ->
                val fraction = animation.animatedFraction
                batteryOffset = fromBattery + (targetBattery - fromBattery) * fraction
                volumeOffset = fromVolume + (targetVolume - fromVolume) * fraction
                invalidate()
            }
            start()
        }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val snapshot = values ?: return
        val size = min(width, height).toFloat()
        val content = size - 2f * discInset
        if (content <= 0f) return
        val unit = content / DESIGN_SIZE
        val cx = width / 2f
        val cy = height / 2f
        val radius = PhoneGaugeGeometry.RING_RADIUS * unit

        canvas.drawCircle(cx, cy, size / 2f - edgePaint.strokeWidth / 2f, glassPaint)
        canvas.drawCircle(cx, cy, size / 2f - edgePaint.strokeWidth / 2f, edgePaint)

        box.set(cx - radius, cy - radius, cx + radius, cy + radius)
        val stroke = PhoneGaugeGeometry.RING_STROKE * unit
        // Every ring sits in the same box, so both arcs keep their caps inside the two openings. Both
        // grow clockwise from their own opening: the battery down the right, the volume up the left.
        drawRing(canvas, TRACK, PhoneGaugeGeometry.BATTERY_START_DEGREES, PhoneGaugeGeometry.ARC_DEGREES, stroke)
        drawRing(canvas, TRACK, PhoneGaugeGeometry.VOLUME_START_DEGREES, PhoneGaugeGeometry.ARC_DEGREES, stroke)
        drawRing(
            canvas, batteryColor, PhoneGaugeGeometry.BATTERY_START_DEGREES,
            PhoneGaugeGeometry.sweepDegrees(batteryOffset), stroke,
        )
        drawRing(
            canvas, INK, PhoneGaugeGeometry.VOLUME_START_DEGREES,
            PhoneGaugeGeometry.sweepDegrees(volumeOffset), stroke,
        )

        drawMark(canvas, snapshot, cx, cy, unit)

        // Read clockwise from the top: battery number, battery arc, volume number, volume arc.
        val batteryText = if (snapshot.battery < 0) "" else snapshot.battery.toString()
        val volumeText = if (snapshot.volume < 0) "" else snapshot.volume.toString()
        numberPaint.textSize = 15f * unit
        numberPaint.color = batteryColor
        canvas.drawText(batteryText, cx, cy + (20f - 50f) * unit, numberPaint)
        numberPaint.color = INK
        canvas.drawText(volumeText, cx, cy + (90f - 50f) * unit, numberPaint)
    }

    private fun drawRing(canvas: Canvas, color: Int, start: Float, sweep: Float, stroke: Float) {
        if (sweep == 0f) return
        ringPaint.color = color
        ringPaint.strokeWidth = stroke
        canvas.drawArc(box, start, sweep, false, ringPaint)
    }

    /**
     * Both marks share one box - scaled and nudged down to the band between the number and the word -
     * so switching networks never changes the icon's size, exactly like the browser's `mark` group.
     */
    private fun drawMark(canvas: Canvas, snapshot: PhoneStatus.Snapshot, cx: Float, cy: Float, unit: Float) {
        canvas.save()
        canvas.translate(0f, MARK_SHIFT * unit)
        canvas.scale(MARK_SCALE, MARK_SCALE, cx, cy)
        if (snapshot.network == "wifi") {
            markPaint.style = Paint.Style.STROKE
            markPaint.strokeWidth = WIFI_STROKE * unit
            markPaint.strokeCap = Paint.Cap.ROUND
            val fanCenter = cy + (WIFI_CENTER_Y - 50f) * unit
            for (index in WIFI_RADII.indices) {
                markPaint.color = if (snapshot.bars > index) INK else TRACK
                val fanRadius = WIFI_RADII[index] * unit
                box.set(cx - fanRadius, fanCenter - fanRadius, cx + fanRadius, fanCenter + fanRadius)
                canvas.drawArc(box, WIFI_START_DEGREES, WIFI_SWEEP_DEGREES, false, markPaint)
            }
            markPaint.style = Paint.Style.FILL
            markPaint.color = if (snapshot.bars >= 1) INK else TRACK
            canvas.drawCircle(cx, fanCenter, WIFI_DOT_RADIUS * unit, markPaint)
        } else {
            markPaint.style = Paint.Style.FILL
            val bottom = cy + (CELL_BASELINE_Y - 50f) * unit
            for (index in CELL_HEIGHTS.indices) {
                markPaint.color = if (snapshot.bars > index) INK else TRACK
                val barHeight = CELL_HEIGHTS[index] * unit
                val barLeft = cx + (CELL_LEFT_X + index * CELL_STEP_X - 50f) * unit
                box.set(barLeft, bottom - barHeight, barLeft + CELL_WIDTH * unit, bottom)
                canvas.drawRoundRect(box, CELL_CORNER * unit, CELL_CORNER * unit, markPaint)
            }
        }
        canvas.restore()
    }

    private companion object {
        // Design units: the SVG below the disc chrome uses a 0..100 viewBox.
        const val DESIGN_SIZE = 100f
        const val DISC_EDGE_DP = 1f
        const val DISC_PADDING_DP = 2f
        const val MARK_SCALE = 0.86f
        const val MARK_SHIFT = 1.8f
        const val WIFI_STROKE = 5f
        const val WIFI_CENTER_Y = 62f
        const val WIFI_DOT_RADIUS = 2.5f
        const val WIFI_START_DEGREES = -128f
        const val WIFI_SWEEP_DEGREES = 76f
        val WIFI_RADII = floatArrayOf(11f, 19f, 27f)
        const val CELL_LEFT_X = 31.25f
        const val CELL_STEP_X = 10.37f
        const val CELL_WIDTH = 6.4f
        const val CELL_BASELINE_Y = 64f
        const val CELL_CORNER = 2.8f
        val CELL_HEIGHTS = floatArrayOf(8f, 16f, 24f, 32f)

        const val SWEEP_MILLIS = 700L
        const val POLL_MILLIS = 1_000L
        const val DRAG_SLOP_DP = 8f

        const val INK = 0xFFDFE4E8.toInt()
        const val TRACK = 0xFF8B95A1.toInt()
        const val LOW = 0xFFFF453A.toInt()
        const val CHARGING = 0xFF30D158.toInt()
        const val GLASS = 0xCC12171C.toInt()
        const val DISC_EDGE = 0x38FFFFFF
    }
}

/**
 * The browser's arithmetic, spelled out for Canvas: the head-unit badge turns a percentage into a dash
 * offset so CSS can interpolate it, and the offset becomes an arc sweep here. An empty reading parks
 * the offset past one full path length - the same `ringEmpty` as in app.js - so a hidden arc leaves no
 * round cap behind at either end of the opening.
 */
internal object PhoneGaugeGeometry {
    /** 180 degrees minus the two 26 degree openings. */
    const val ARC_DEGREES = 180f - 2f * 26f
    const val RING_RADIUS = 44f
    const val RING_STROKE = 9f
    private const val STUB_PERCENT = 6f
    const val EMPTY_OFFSET = 107f
    // Canvas angles start at 3 o'clock while the SVG starts at 12 o'clock, hence the quarter turn. Every
    // arc then sweeps clockwise from the opening its own number sits in - the battery from the top one
    // down the right, the volume from the bottom one up the left.
    const val BATTERY_START_DEGREES = 26f - 90f
    const val VOLUME_START_DEGREES = 180f + 26f - 90f

    /** A reading too small to see still leaves a stub, so it never reads as a missing stroke. */
    fun dashOffset(percent: Int?): Float =
        if (percent == null || percent <= 0) EMPTY_OFFSET else 100f - max(STUB_PERCENT, percent.toFloat())

    /** Degrees of arc an offset covers; at or past 100 nothing is drawn. */
    fun sweepDegrees(offset: Float): Float =
        ((100f - offset) / 100f).coerceAtLeast(0f) * ARC_DEGREES

    /** An empty circle must never float over the picture, the same rule the browser applies. */
    fun showsGauge(snapshot: PhoneStatus.Snapshot?): Boolean =
        snapshot != null && (snapshot.battery >= 0 || snapshot.volume >= 0 || snapshot.network != "none")
}
