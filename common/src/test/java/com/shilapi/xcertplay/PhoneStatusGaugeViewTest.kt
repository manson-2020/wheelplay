// SPDX-License-Identifier: AGPL-3.0-only
package com.shilapi.xcertplay

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.view.View
import com.shilapi.xcertplay.web.PhoneStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin

/**
 * Draws the on-phone gauge off-screen, so the geometry is checked as pixels: which side of the ring
 * carries which reading, that the two openings stay bare, and - the bug the browser badge had - that a
 * zero reading leaves no sliver of ink at either end of an arc.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class PhoneStatusGaugeViewTest {
    private val size = 216
    private val center = size / 2

    private val radius: Float
        get() {
            val density = RuntimeEnvironment.getApplication().resources.displayMetrics.density
            // The viewBox sits inside a 1 dp border and 2 dp padding, exactly like the CSS disc.
            return (size - 2f * 3f * density) / 100f * PhoneGaugeGeometry.RING_RADIUS
        }

    private fun render(
        battery: Int,
        volume: Int,
        network: String = "wifi",
        bars: Int = 4,
        charging: Boolean = false,
    ): Bitmap {
        val view = PhoneStatusGaugeView(RuntimeEnvironment.getApplication())
        view.apply(PhoneStatus.Snapshot(battery, charging, volume, network, bars), animate = false)
        view.measure(
            View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, size, size)
        return Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
    }

    /** The brightest channel in a window; ink is ~226, the track ~161 and the dark glass under 40. */
    private fun brightest(bitmap: Bitmap, x: Float, y: Float, reach: Int): Int {
        var best = 0
        for (py in (y.toInt() - reach)..(y.toInt() + reach)) {
            for (px in (x.toInt() - reach)..(x.toInt() + reach)) {
                if (px !in 0 until size || py !in 0 until size) continue
                val pixel = bitmap.getPixel(px, py)
                best = max(best, max(Color.red(pixel), max(Color.green(pixel), Color.blue(pixel))))
            }
        }
        return best
    }

    /** The pixel on the ring at [degrees] in Canvas angles (0 = 3 o'clock). */
    private fun ringColor(bitmap: Bitmap, degrees: Float): Int {
        val radians = Math.toRadians(degrees.toDouble())
        return bitmap.getPixel(
            (center + radius * cos(radians)).toInt(),
            (center + radius * sin(radians)).toInt(),
        )
    }

    /** The left side is the volume meter, the right one the battery - read clockwise from the top. */
    private fun volumeMeter(bitmap: Bitmap) = brightest(bitmap, center - radius, center.toFloat(), 6)
    private fun batteryArc(bitmap: Bitmap) = brightest(bitmap, center + radius, center.toFloat(), 6)

    @Test
    fun aZeroReadingKeepsTheBatteryArcAndTheMeterOnTheGreyTrack() {
        val bitmap = render(0, 0)
        val left = volumeMeter(bitmap)
        val right = batteryArc(bitmap)
        // Ink is what a sliver of progress looks like; the track must survive so the ring reads as empty.
        assertTrue("an empty battery arc must not show ink, found $right", right < 190)
        assertTrue("an empty meter must not show ink, found $left", left < 190)
        assertTrue("an empty ring must still draw its track, found $right", right > 60)
        assertTrue("an empty meter must still draw its ticks, found $left", left > 60)
    }

    @Test
    fun aFullReadingPaintsInkAcrossTheArcAndTheMeter() {
        val bitmap = render(100, 100)
        assertTrue("a full battery arc must be ink, found ${batteryArc(bitmap)}", batteryArc(bitmap) > 200)
        assertTrue("a full meter must be ink, found ${volumeMeter(bitmap)}", volumeMeter(bitmap) > 200)
    }

    @Test
    fun theVolumeMeterLeavesAGapBetweenItsTicks() {
        val bitmap = render(88, 100)
        // 9 o'clock falls between the fourth and fifth tick, and even a full meter keeps that gap dark.
        val gap = ringColor(bitmap, 180f)
        val tick = ringColor(bitmap, 172f)
        assertTrue("the gap between two ticks must stay empty, found $gap", Color.green(gap) < 160)
        assertTrue("a lit tick must be ink, found $tick", Color.green(tick) > 200)
    }

    @Test
    fun theBatteryArcIsInkWhenHealthyRedWhenLowAndGreenWhileCharging() {
        // A few degrees past the battery arc's start, which every reading paints.
        val degrees = PhoneGaugeGeometry.BATTERY_START_DEGREES + 8
        val healthy = ringColor(render(88, 64), degrees)
        val low = ringColor(render(10, 64), degrees)
        val charging = ringColor(render(10, 64, charging = true), degrees)
        // Healthy keeps the neutral ink the volume ring uses: bright, but with no hue of its own.
        assertTrue(
            "a healthy reading must stay neutral ink, found $healthy",
            Color.green(healthy) - Color.red(healthy) < 20 && Color.green(healthy) > 180,
        )
        assertTrue("a low reading must be red, found $low", Color.red(low) > Color.green(low) + 100)
        assertTrue(
            "a phone on the charger must be green, found $charging",
            Color.green(charging) > Color.red(charging) + 60,
        )
    }

    @Test
    fun theCollarStopsShortOfTheArcCaps() {
        val bitmap = render(88, 64)
        val unit = radius / PhoneGaugeGeometry.RING_RADIUS
        // Between the collar's end and the arc's round cap the opening stays empty, top and bottom.
        val top = brightest(bitmap, center + 18.7f * unit, center - 41.9f * unit, 1)
        val bottom = brightest(bitmap, center + 18.7f * unit, center + 41.9f * unit, 1)
        assertTrue("the collar must not touch the top cap, found $top", top < 190)
        assertTrue("the collar must not touch the bottom cap, found $bottom", bottom < 190)
    }

    @Test
    fun theBatteryNumberSitsInsideTheTopOpening() {
        val bitmap = render(88, 64)
        val unit = radius / PhoneGaugeGeometry.RING_RADIUS
        var best = 0
        // The number's baseline is 29 design units above the centre, 13 units tall.
        for (y in (center - 46 * unit).toInt()..(center - 18 * unit).toInt()) {
            best = max(best, brightest(bitmap, center.toFloat(), y.toFloat(), 20))
        }
        assertTrue("the reading must be drawn between the arc caps, found $best", best > 200)
    }

    @Test
    fun aPlugGoingInRepaintsEvenWhenNeitherArcMoves() {
        val view = PhoneStatusGaugeView(RuntimeEnvironment.getApplication())
        view.apply(PhoneStatus.Snapshot(64, false, 40, "wifi", 3), animate = false)
        val shadow = shadowOf(view)
        shadow.clearWasInvalidated()
        // Same numbers, the cable goes in: only the colour changes, and it still has to reach the glass.
        view.apply(PhoneStatus.Snapshot(64, true, 40, "wifi", 3), animate = false)
        assertTrue("the new battery colour must repaint the gauge", shadow.wasInvalidated())
        shadow.clearWasInvalidated()
        // A reading that repeats itself is not worth a frame.
        view.apply(PhoneStatus.Snapshot(64, true, 40, "wifi", 3), animate = false)
        assertFalse("an unchanged reading must not repaint", shadow.wasInvalidated())
    }

    @Test
    fun eachNumberSitsUnderItsOwnCollarArc() {
        val bitmap = render(84, 20)
        val unit = radius / PhoneGaugeGeometry.RING_RADIUS
        // The middle of the battery collar and of the volume collar; both sit on the disc's axis.
        val batteryCollar = brightest(bitmap, center.toFloat(), center - 47f * unit, 3)
        // The volume collar is dashed, so the window spans a whole dash period.
        val volumeCollar = brightest(bitmap, center.toFloat(), center + 47f * unit, 5)
        assertTrue("the battery number needs its solid arc, found $batteryCollar", batteryCollar > 200)
        assertTrue("the volume number needs its dashed arc, found $volumeCollar", volumeCollar > 200)
    }

    @Test
    fun theSignalMarkSitsInTheMiddleOfTheDisc() {
        val bitmap = render(88, 64, network = "wifi", bars = 4)
        val mark = brightest(bitmap, center.toFloat(), center.toFloat(), 30)
        assertTrue("the Wi-Fi fan must be drawn in the centre, found $mark", mark > 200)
    }

    @Test
    fun aCellularMarkKeepsItsBarsEvenWithNoSignal() {
        // The bars never disappear: at zero they fall back to the track colour, like the browser's.
        val lit = render(88, 64, network = "5g", bars = 4)
        val dead = render(88, 64, network = "5g", bars = 0)
        val litMark = brightest(lit, center.toFloat(), center.toFloat(), 30)
        val deadMark = brightest(dead, center.toFloat(), center.toFloat(), 30)
        assertTrue("lit bars must be ink, found $litMark", litMark > 200)
        assertTrue("dead bars must stay grey, found $deadMark", deadMark in 90..190)
    }
}
