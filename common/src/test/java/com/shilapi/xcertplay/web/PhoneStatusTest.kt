package com.shilapi.xcertplay.web

import android.telephony.TelephonyManager
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The badge only renders numbers the platform already knows; these tests cover the translation of
 * those numbers into what a driver reads off a status bar.
 */
class PhoneStatusTest {
    @Test
    fun radioTechnologiesBecomeTheGenerationsADriverRecognises() {
        assertEquals("5g", PhoneStatus.generation(TelephonyManager.NETWORK_TYPE_NR))
        assertEquals("4g", PhoneStatus.generation(TelephonyManager.NETWORK_TYPE_LTE))
        assertEquals("3g", PhoneStatus.generation(TelephonyManager.NETWORK_TYPE_HSPA))
        assertEquals("2g", PhoneStatus.generation(TelephonyManager.NETWORK_TYPE_EDGE))
        // A radio the platform will not name still gets an icon, just no invented generation.
        assertEquals("cellular", PhoneStatus.generation(TelephonyManager.NETWORK_TYPE_UNKNOWN))
    }

    @Test
    fun wifiBarsUseTheUsableSignalThresholds() {
        assertEquals(4, PhoneStatus.wifiBars(-40))
        assertEquals(3, PhoneStatus.wifiBars(-60))
        assertEquals(2, PhoneStatus.wifiBars(-70))
        assertEquals(1, PhoneStatus.wifiBars(-80))
        assertEquals(0, PhoneStatus.wifiBars(-95))
        // An unreadable level sits on a live connection, so it must not read as "no signal".
        assertEquals(4, PhoneStatus.wifiBars(Int.MIN_VALUE))
    }

    @Test
    fun cellularLevelIsAlreadyABarCount() {
        assertEquals(2, PhoneStatus.cellularBars(2))
        assertEquals(4, PhoneStatus.cellularBars(9))
        assertEquals(4, PhoneStatus.cellularBars(-1))
    }

    @Test
    fun batteryScalesRoundToAPercentage() {
        assertEquals(63, PhoneStatus.percent(63, 100))
        assertEquals(50, PhoneStatus.percent(7, 14))
        assertEquals(100, PhoneStatus.percent(200, 100))
        assertEquals(-1, PhoneStatus.percent(-1, 100))
        assertEquals(-1, PhoneStatus.percent(50, 0))
    }

    @Test
    fun mediaVolumeNormalisesThePerDeviceStreamScaleToAPercent() {
        // Most phones expose 0..15 steps; some expose 0..100.
        assertEquals(60, PhoneStatus.volumePercent(9, 15))
        assertEquals(100, PhoneStatus.volumePercent(15, 15))
        assertEquals(0, PhoneStatus.volumePercent(0, 15))
        assertEquals(-1, PhoneStatus.volumePercent(-1, 15))
        assertEquals(-1, PhoneStatus.volumePercent(5, 0))
    }

    @Test
    fun theRedWarningStartsWhereThePlatformBatteryWarningStarts() {
        assertEquals(20, PhoneStatus.LOW_BATTERY_PERCENT)
    }
}
