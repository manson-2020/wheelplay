package com.shilapi.xcertplay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The on-phone canvas expansion keeps the dp proportion (both edges scale by the same factor), stays
 * even, and never exceeds the 3840x2160 box the negotiation pipeline already accepts.
 */
class PhoneDisplayCanvasTest {
    @Test
    fun physicalPixelsScaleTheDpCanvasWithoutChangingProportion() {
        // A 2718x1260-px panel at density 3 negotiates 906x420 dp; the px twin must land back on
        // the panel size 1:1, not the dp canvas upscaled by the renderer.
        assertEquals(2718 to 1260, CarPlayPhoneDisplay.landscapePx(906, 420, 3f))
        assertEquals(1804 to 836, CarPlayPhoneDisplay.landscapePx(902, 418, 2f))
    }

    @Test
    fun oversizedCanvasesShrinkToTheMaximumBoxAndRemainEven() {
        // 2000x900 dp at density 3 would be 6000x2700: capped by the width to 3840 wide, even.
        assertEquals(3840 to 1728, CarPlayPhoneDisplay.landscapePx(2000, 900, 3f))
        // Height binds first for a squarer canvas: 1200x1000 dp at 3 caps on the 2160 height.
        assertEquals(2592 to 2160, CarPlayPhoneDisplay.landscapePx(1200, 1000, 3f))
    }

    @Test
    fun densityBelowOneAndEmptyCanvasesAreRejected() {
        // A nonsense density falls back to 1: the canvas stays at its dp numbers.
        assertEquals(906 to 420, CarPlayPhoneDisplay.landscapePx(906, 420, 0.5f))
        assertNull(CarPlayPhoneDisplay.landscapePx(0, 420, 3f))
        assertNull(CarPlayPhoneDisplay.landscapePx(100, 100, 1f))
    }

    @Test
    fun expansionKeepsTheLongEdgeFirstRegardlessOfOrientation() {
        // The preview hands over the landscape pair; a portrait-ordered input still yields long x short.
        assertEquals(2718 to 1260, CarPlayPhoneDisplay.landscapePx(420, 906, 3f))
    }

    @Test
    fun watchingBrowserKeepsTheDpCanvasWhileThePhonePathUsesThePxTwin() {
        val recorded = 906 to 420
        val pxTwin = 2718 to 1260
        // No head-unit viewer yet: the phone-path default starts at the px twin so the on-phone
        // picture is 1:1 sharp from the first frame.
        assertEquals(pxTwin, CarPlayPhoneDisplay.selectDefaultDisplayPair(recorded, pxTwin, false, false))
        // The local preview owns the canvas: still the px twin even with a browser online, which is
        // what keeps entering and leaving the preview from renegotiating twice.
        assertEquals(pxTwin, CarPlayPhoneDisplay.selectDefaultDisplayPair(recorded, pxTwin, true, true))
        assertEquals(pxTwin, CarPlayPhoneDisplay.selectDefaultDisplayPair(recorded, pxTwin, false, true))
        // A watching browser gets the pre-expansion dp canvas back - the px twin must never leak
        // into the web stream, that is what blurred the head-unit picture.
        assertEquals(recorded, CarPlayPhoneDisplay.selectDefaultDisplayPair(recorded, pxTwin, true, false))
        // A browser-view record carries no px twin; every path stays on the recorded size.
        assertEquals(recorded, CarPlayPhoneDisplay.selectDefaultDisplayPair(recorded, null, true, false))
        assertEquals(recorded, CarPlayPhoneDisplay.selectDefaultDisplayPair(recorded, null, false, false))
        // Nothing recorded: the caller falls back to its own browser default.
        assertNull(CarPlayPhoneDisplay.selectDefaultDisplayPair(null, pxTwin, true, false))
        assertNull(CarPlayPhoneDisplay.selectDefaultDisplayPair(null, pxTwin, false, false))
    }
}
