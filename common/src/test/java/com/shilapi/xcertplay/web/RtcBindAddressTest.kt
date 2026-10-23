package com.shilapi.xcertplay.web

import org.junit.Assert.*
import org.junit.Test

class RtcBindAddressTest {
    private val local = listOf("6.6.6.6", "192.168.43.1", "127.0.0.1")

    @Test fun bindsToTheAddressTheBrowserReached() {
        assertEquals("6.6.6.6", RtcBindAddress.addressForConnection("6.6.6.6", local))
        assertEquals("192.168.43.1", RtcBindAddress.addressForConnection("192.168.43.1", local))
        // A dual-stack server socket reports the same peer as an IPv4-mapped IPv6 literal.
        assertEquals("6.6.6.6", RtcBindAddress.addressForConnection("::ffff:6.6.6.6", local))
        assertEquals("6.6.6.6", RtcBindAddress.addressForConnection("[::ffff:6.6.6.6]", local))
    }

    @Test fun ignoresAddressesThatCannotReachAHeadUnit() {
        assertNull(RtcBindAddress.addressForConnection("192.168.1.5", local))
        assertNull(RtcBindAddress.addressForConnection("127.0.0.1", local))
        assertNull(RtcBindAddress.addressForConnection("999.1.1.1", local))
        assertNull(RtcBindAddress.addressForConnection("tesla.start0699.top", local))
        assertNull(RtcBindAddress.addressForConnection("fe80::1", local))
        assertNull(RtcBindAddress.addressForConnection(null, local))
    }
}
