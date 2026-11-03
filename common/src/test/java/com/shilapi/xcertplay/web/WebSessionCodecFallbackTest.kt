package com.shilapi.xcertplay.web

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class WebSessionCodecFallbackTest {
    @After
    fun detach() = WebSession.setHevcUnusableHandler(null)

    @Test
    fun anHevcRejectionReachesTheHostThatCanRenegotiate() {
        val sources = mutableListOf<String>()
        WebSession.setHevcUnusableHandler { sources += it }
        WebSession.reportHevcUnusable("webcodecs")
        assertEquals(listOf("webcodecs"), sources)
        // Without a host (activity destroyed) the report must be dropped, not queued for whoever
        // registers next: the answer only matters to the session that is running now.
        WebSession.setHevcUnusableHandler(null)
        WebSession.reportHevcUnusable("webrtc")
        assertEquals(listOf("webcodecs"), sources)
    }
}
