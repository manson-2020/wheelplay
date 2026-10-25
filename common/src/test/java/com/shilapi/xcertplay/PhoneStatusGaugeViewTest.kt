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

    /** The left arc now carries the volume, the right one the battery - read clockwise from the top. */
    private fun volumeArc(bitmap: Bitmap) = brightest(bitmap, center - radius, center.toFloat(), 6)
    private fun batteryArc(bitmap: Bitmap) = brightest(bitmap, center + radius, center.toFloat(), 6)

    @Test
    fun aZeroReadingKeepsBothArcMidpointsOnTheGreyTrack() {
        val bitmap = render(0, 0)
        val left = volumeArc(bitmap)
        val right = batteryArc(bitmap)
        // Ink is what a sliver of progress looks like; the track must survive so the ring reads as empty.
        assertTrue("an empty battery arc must not show ink, found $right", right < 190)
        assertTrue("an empty volume arc must not show ink, found $left", left < 190)
        assertTrue("an empty ring must still draw its track, found $right", right > 60)
        assertTrue("an empty ring must still draw its track, found $left", left > 60)
    }

    @Test
    fun aFullReadingPaintsInkAcrossBothArcs() {
        val bitmap = render(100, 100)
        assertTrue("a full battery arc must be ink, found ${batteryArc(bitmap)}", batteryArc(bitmap) > 200)
        assertTrue("a full volume arc must be ink, found ${volumeArc(bitmap)}", volumeArc(bitmap) > 200)
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
    fun theTopAndBottomOpeningsStayBareForTheNumberAndTheWord() {
        val bitmap = render(88, 64)
        // Sample just outside the ring, clear of the glyph descenders that reach into the openings.
        val top = brightest(bitmap, center.toFloat(), center - radius - 5, 2)
        val bottom = brightest(bitmap, center.toFloat(), center + radius + 5, 2)
        assertTrue("the top opening must stay open, found $top", top < 190)
        assertTrue("the bottom opening must stay open, found $bottom", bottom < 190)
    }

    @Test
    fun theBatteryNumberSitsInsideTheTopOpening() {
        val bitmap = render(88, 64)
        val unit = radius / PhoneGaugeGeometry.RING_RADIUS
        var best = 0
        // The number's baseline is 30 design units above the centre, 15 units tall.
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
