package com.shilapi.xcertplay.web

import org.junit.Assert.*
import org.junit.Test

class RtcBindAddressTest {
    private val local = listOf("6.6.6.6", "192.168.43.1", "127.0.0.1")

    @Test fun bindsToTheAddressTheBrowserReached() {
        assertEquals("6.6.6.6", RtcBindAddress.addressForHost("6.6.6.6:8080", local))
        assertEquals("192.168.43.1", RtcBindAddress.addressForHost("192.168.43.1", local))
    }

    @Test fun ignoresHostsThatAreNotAUsableLocalAddress() {
        assertNull(RtcBindAddress.addressForHost("192.168.1.5:8080", local))
        assertNull(RtcBindAddress.addressForHost("wheelplay.local:8080", local))
        assertNull(RtcBindAddress.addressForHost("[::1]:8080", local))
        assertNull(RtcBindAddress.addressForHost("127.0.0.1:8080", local))
        assertNull(RtcBindAddress.addressForHost("999.1.1.1:8080", local))
        assertNull(RtcBindAddress.addressForHost("", local))
        assertNull(RtcBindAddress.addressForHost(null, local))
    }
}
