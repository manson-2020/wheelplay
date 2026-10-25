// SPDX-License-Identifier: AGPL-3.0-only
package com.shilapi.xcertplay

import com.shilapi.xcertplay.web.PhoneStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The on-phone gauge and the browser gauge are two renderers over one reading, so these numbers are
 * the contract between them: they must stay identical to `ringDash` and `phoneStatusMarkup` in
 * common/src/main/assets/web/app.js.
 */
class PhoneGaugeGeometryTest {
    @Test
    fun dashOffsetMirrorsTheBrowser() {
        assertEquals(107f, PhoneGaugeGeometry.dashOffset(null), 0.001f)
        assertEquals(107f, PhoneGaugeGeometry.dashOffset(0), 0.001f)
        // A reading too small to see still leaves a six percent stub.
        assertEquals(94f, PhoneGaugeGeometry.dashOffset(3), 0.001f)
        assertEquals(94f, PhoneGaugeGeometry.dashOffset(6), 0.001f)
        assertEquals(93f, PhoneGaugeGeometry.dashOffset(7), 0.001f)
        assertEquals(12f, PhoneGaugeGeometry.dashOffset(88), 0.001f)
        assertEquals(0f, PhoneGaugeGeometry.dashOffset(100), 0.001f)
    }

    @Test
    fun anEmptyOffsetDrawsNoArcAtAll() {
        assertEquals(0f, PhoneGaugeGeometry.sweepDegrees(PhoneGaugeGeometry.EMPTY_OFFSET), 0.001f)
        // Exactly one path length would leave the round cap sitting on the arc's start.
        assertEquals(0f, PhoneGaugeGeometry.sweepDegrees(100f), 0.001f)
        assertEquals(0f, PhoneGaugeGeometry.sweepDegrees(120f), 0.001f)
        assertEquals(6.852f, PhoneGaugeGeometry.sweepDegrees(94f), 0.001f)
        assertEquals(100.496f, PhoneGaugeGeometry.sweepDegrees(12f), 0.001f)
        assertEquals(PhoneGaugeGeometry.BATTERY_ARC_DEGREES, PhoneGaugeGeometry.sweepDegrees(0f), 0.001f)
    }

    @Test
    fun theBatteryArcIsInsetToEndWhereTheMeterDoes() {
        // The tick meter's outer tick stops 5.25 degrees short of the opening and its round cap only
        // reaches 4.23 further; the battery arc's cap reaches 5.86. The inset makes up the difference,
        // so both runs stop 27 degrees from the opening and neither side reads as shorter.
        assertEquals(6.9f, PhoneGaugeGeometry.BATTERY_INSET_DEGREES, 0.001f)
        assertEquals(114.2f, PhoneGaugeGeometry.BATTERY_ARC_DEGREES, 0.001f)
        assertEquals(128f, PhoneGaugeGeometry.ARC_DEGREES, 0.001f)
    }

    @Test
    fun theTwoOpeningsLeaveOneHundredAndTwentyEightDegrees() {
        assertEquals(128f, PhoneGaugeGeometry.ARC_DEGREES, 0.001f)
        // Canvas starts at 3 o'clock, so the SVG's top opening sits 26 degrees past 12 and the bottom
        // one 26 degrees past 6. Both arcs then sweep clockwise from their own opening.
        assertEquals(-64f, PhoneGaugeGeometry.BATTERY_START_DEGREES, 0.001f)
        assertEquals(116f, PhoneGaugeGeometry.VOLUME_START_DEGREES, 0.001f)
        // Read clockwise: the battery arc ends on the right below its number, the volume arc on the
        // left above its own.
        assertEquals(64f, PhoneGaugeGeometry.BATTERY_START_DEGREES + PhoneGaugeGeometry.ARC_DEGREES, 0.001f)
        assertEquals(244f, PhoneGaugeGeometry.VOLUME_START_DEGREES + PhoneGaugeGeometry.ARC_DEGREES, 0.001f)
    }

    @Test
    fun theVolumeMeterIsEightTicksWithGapsBetween() {
        assertEquals(8, PhoneGaugeGeometry.TICK_COUNT)
        // Sixteen degree slots. A round cap reaches 4.23 degrees past each end, so the slot gives up
        // 10.5 of it to gap and the tick body is the remaining 5.5.
        assertEquals(121.25f, PhoneGaugeGeometry.tickStartDegrees(0), 0.001f)
        assertEquals(233.25f, PhoneGaugeGeometry.tickStartDegrees(7), 0.001f)
        assertEquals(5.5f, PhoneGaugeGeometry.tickSweepDegrees(0, 1f), 0.001f)
        // The last tick's cap stops at 242.5, clear of the top opening that starts at 244.
        assertEquals(
            238.75f,
            PhoneGaugeGeometry.tickStartDegrees(7) + PhoneGaugeGeometry.tickSweepDegrees(7, 1f),
            0.001f,
        )
        // The tick holding the level is filled part of the way; the ones past it stay empty.
        assertEquals(1.1f, PhoneGaugeGeometry.tickSweepDegrees(3, 0.4f), 0.001f)
        assertEquals(0f, PhoneGaugeGeometry.tickSweepDegrees(4, 0.4f), 0.001f)
    }

    @Test
    fun anUnreadableVolumeLightsNoTick() {
        assertEquals(0f, PhoneGaugeGeometry.levelFraction(null), 0.001f)
        assertEquals(0f, PhoneGaugeGeometry.levelFraction(-1), 0.001f)
        assertEquals(0.4f, PhoneGaugeGeometry.levelFraction(40), 0.001f)
        assertEquals(1f, PhoneGaugeGeometry.levelFraction(150), 0.001f)
    }

    @Test
    fun anUnreadablePhoneLeavesTheGaugeHidden() {
        assertFalse(PhoneGaugeGeometry.showsGauge(null))
        assertFalse(PhoneGaugeGeometry.showsGauge(PhoneStatus.Snapshot(-1, false, -1, "none", 0)))
        assertTrue(PhoneGaugeGeometry.showsGauge(PhoneStatus.Snapshot(-1, false, 40, "none", 0)))
        assertTrue(PhoneGaugeGeometry.showsGauge(PhoneStatus.Snapshot(88, false, -1, "wifi", 3)))
    }
}
