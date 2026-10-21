package com.shilapi.xcertplay.web

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RtcSdpSummaryTest {
    private val offer =
        """
        v=0
        o=- 1 1 IN IP4 0.0.0.0
        s=-
        t=0 0
        a=group:BUNDLE 0
        m=video 9 UDP/TLS/RTP/SAVPF 96
        c=IN IP4 0.0.0.0
        a=mid:0
        a=rtpmap:96 H264/90000
        a=fmtp:96 packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1
        a=setup:actpass
        a=candidate:1 1 UDP 2122260223 192.168.43.10 50000 typ host
        a=candidate:2 1 UDP 1686052607 1ab2cd.local 60000 typ host
        a=candidate:3 1 UDP 1686052607 203.0.113.7 60001 typ srflx raddr 192.168.43.10 rport 50000
        """.trimIndent()

    @Test
    fun offerSummaryNamesMediaCodecRoleAndCandidateTypes() {
        val summary = RtcSdpSummary.summarize(offer)
        assertEquals("video:9", summary.media)
        assertTrue(summary.codecs.startsWith("H264/90000 "))
        assertTrue(summary.codecs.contains("profile-level-id=42e01f"))
        assertEquals("actpass", summary.setup)
        assertEquals("host:2,srflx:1,relay:0,mdns:1", summary.candidates)
        assertEquals("42e01f", summary.profileLevelId)
        assertFalse(summary.mainOrHighProfile)
        assertTrue(summary.describe().contains("media=video:9"))
    }

    @Test
    fun rejectedAnswerKeepsPortZeroAndFlagsMainOrHighProfile() {
        val answer =
            """
            m=video 0 UDP/TLS/RTP/SAVPF 96
            a=rtpmap:96 H264/90000
            a=fmtp:96 level-asymmetry-allowed=1;profile-level-id=64001f
            a=setup:active
            """.trimIndent()
        val summary = RtcSdpSummary.summarize(answer)
        assertEquals("video:0", summary.media)
        assertEquals("active", summary.setup)
        assertEquals("host:0,srflx:0,relay:0,mdns:0", summary.candidates)
        assertEquals("64001f", summary.profileLevelId)
        assertTrue(summary.mainOrHighProfile)
    }

    @Test
    fun onlyTheFirstPayloadTypeSuppliesTheCodecLine() {
        val sdp =
            """
            m=video 9 UDP/TLS/RTP/SAVPF 96 97
            a=rtpmap:96 H264/90000
            a=rtpmap:97 rtx/90000
            a=fmtp:96 profile-level-id=4d001f
            a=fmtp:97 apt=96
            a=setup:passive
            """.trimIndent()
        val summary = RtcSdpSummary.summarize(sdp)
        assertTrue(summary.codecs.startsWith("H264/90000"))
        assertFalse(summary.codecs.contains("rtx"))
        assertEquals("4d001f", summary.profileLevelId)
        assertTrue(summary.mainOrHighProfile)
        assertEquals("passive", summary.setup)
    }

    @Test
    fun missingOrMalformedSdpNeverThrows() {
        for (sdp in listOf(null, "", "   ", "v=0\r\nm=video\r\na=candidate:only-one-field")) {
            val summary = RtcSdpSummary.summarize(sdp)
            assertEquals("none", summary.setup)
            assertNull(summary.profileLevelId)
            assertFalse(summary.mainOrHighProfile)
            assertTrue(summary.candidates.startsWith("host:0"))
            assertEquals("none", summary.codecs)
        }
    }
}
