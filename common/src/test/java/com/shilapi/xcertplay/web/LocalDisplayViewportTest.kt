package com.shilapi.xcertplay.web

import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class LocalDisplayViewportTest {
    @After
    fun cleanup() {
        WebSession.setBrowserViewportListener(null)
        WebSession.stop()
    }

    @Test
    fun returningFromLocalDisplayWithoutAViewerDoesNotRenegotiateTheCanvas() {
        val sizes = mutableListOf<Pair<Int?, Int?>>()
        WebSession.setBrowserViewportListener { width, height -> sizes.add(width to height) }
        // Entering the on-phone preview renegotiates the canvas to the phone size.
        WebSession.beginLocalDisplay(906, 420)
        assertEquals(906 to 420, sizes.last())
        val sizeAfterBegin = sizes.size
        // No head-unit browser is watching, so leaving must keep the canvas - no redundant restart.
        WebSession.endLocalDisplay()
        assertEquals(sizeAfterBegin, sizes.size)
    }
}
