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
        assertEquals(7.68f, PhoneGaugeGeometry.sweepDegrees(94f), 0.001f)
        assertEquals(112.64f, PhoneGaugeGeometry.sweepDegrees(12f), 0.001f)
        assertEquals(PhoneGaugeGeometry.ARC_DEGREES, PhoneGaugeGeometry.sweepDegrees(0f), 0.001f)
    }

    @Test
    fun theTwoOpeningsLeaveOneHundredAndTwentyEightDegrees() {
        assertEquals(128f, PhoneGaugeGeometry.ARC_DEGREES, 0.001f)
        // Canvas starts at 3 o'clock, so the volume arc begins a quarter turn before the SVG.
        assertEquals(-64f, PhoneGaugeGeometry.VOLUME_START_DEGREES, 0.001f)
        assertEquals(-116f, PhoneGaugeGeometry.BATTERY_START_DEGREES, 0.001f)
    }

    @Test
    fun everyTransportFillsTheBottomOpeningWithItsBrowserWord() {
        assertEquals("WIFI", PhoneGaugeGeometry.label("wifi"))
        assertEquals("5G", PhoneGaugeGeometry.label("5g"))
        assertEquals("4G", PhoneGaugeGeometry.label("4g"))
        assertEquals("3G", PhoneGaugeGeometry.label("3g"))
        assertEquals("2G", PhoneGaugeGeometry.label("2g"))
        assertEquals("NET", PhoneGaugeGeometry.label("cellular"))
        assertEquals("LAN", PhoneGaugeGeometry.label("eth"))
        assertEquals("OFF", PhoneGaugeGeometry.label("none"))
        assertEquals("OFF", PhoneGaugeGeometry.label("bogus"))
    }

    @Test
    fun anUnreadablePhoneLeavesTheGaugeHidden() {
        assertFalse(PhoneGaugeGeometry.showsGauge(null))
        assertFalse(PhoneGaugeGeometry.showsGauge(PhoneStatus.Snapshot(-1, false, -1, "none", 0)))
        assertTrue(PhoneGaugeGeometry.showsGauge(PhoneStatus.Snapshot(-1, false, 40, "none", 0)))
        assertTrue(PhoneGaugeGeometry.showsGauge(PhoneStatus.Snapshot(88, false, -1, "wifi", 3)))
    }
}
