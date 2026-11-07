package com.shilapi.xcertplay.network

import org.junit.Assert.*
import org.junit.Test

class CarHotspotStatusTest {
    private fun on(legacy: Boolean?, tethered: List<String>?) =
        CarHotspotStatus.hotspotOn(legacy, tethered)

    @Test fun legacyEnabledWins() {
        assertEquals(true, on(true, emptyList()))
        assertEquals(true, on(true, null))
    }

    @Test fun legacyUnobservableNeverBlocks() {
        assertEquals(null, on(null, emptyList()))
        assertEquals(null, on(null, null))
    }

    @Test fun legacyOffWithNoTetheredDownstreamStaysOff() {
        assertEquals(false, on(false, emptyList()))
        assertEquals(false, on(false, listOf("usb0", "bt-pan")))
    }

    @Test fun tetheringStackOverrulesLegacyOff() {
        // Huawei/Honor run the hotspot on p2pN while the AOSP soft-AP state stays disabled.
        assertEquals(true, on(false, listOf("p2p0")))
        assertEquals(true, on(false, listOf("ap0")))
        assertEquals(true, on(false, listOf("softap0")))
        assertEquals(true, on(false, listOf("wlan0")))
        assertEquals(true, on(false, listOf("usb0", "ap_br_wlan0")))
        assertEquals(true, on(false, listOf("swlan0")))
    }

    @Test fun wifiDirectGroupIsNotAHotspot() {
        assertEquals(false, on(false, listOf("p2p-p2p0-0")))
        assertEquals(false, on(false, listOf("p2p-wlan0-0")))
    }
}
