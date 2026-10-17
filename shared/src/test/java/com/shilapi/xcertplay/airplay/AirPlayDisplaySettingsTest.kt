package com.shilapi.xcertplay.airplay

import org.junit.Assert.assertEquals
import org.junit.Test

class AirPlayDisplaySettingsTest {
    @Test
    fun maximumObservedWidthScalesPhysicalSizeWithCurrentActivityWidth() {
        val size = AirPlayDisplaySettings.resolvePhysicalSizeMm(
            currentWidthPixels = 768,
            currentHeightPixels = 800,
            maximumWidthPixels = 1920,
            maximumHeightPixels = 1080,
            referenceMillimeters = 200,
            basis = AirPlayPhysicalSizeBasis.WIDTH,
        )

        assertEquals(80, size.widthMm)
        assertEquals(83, size.heightMm)
    }

    @Test
    fun maximumObservedHeightScalesPhysicalSizeWithCurrentActivityHeight() {
        val size = AirPlayDisplaySettings.resolvePhysicalSizeMm(
            currentWidthPixels = 1920,
            currentHeightPixels = 978,
            maximumWidthPixels = 1920,
            maximumHeightPixels = 1080,
            referenceMillimeters = 200,
            basis = AirPlayPhysicalSizeBasis.HEIGHT,
        )

        assertEquals(356, size.widthMm)
        assertEquals(181, size.heightMm)
    }

    @Test
    fun maximumResolutionKeepsConfiguredReferenceLength() {
        val size = AirPlayDisplaySettings.resolvePhysicalSizeMm(
            currentWidthPixels = 1920,
            currentHeightPixels = 1080,
            maximumWidthPixels = 1920,
            maximumHeightPixels = 1080,
            referenceMillimeters = 250,
            basis = AirPlayPhysicalSizeBasis.WIDTH,
        )

        assertEquals(250, size.widthMm)
        assertEquals(141, size.heightMm)
    }

    @Test
    fun authoritativeViewportReportsConfiguredWidthIndependentOfCrossDeviceHistory() {
        // Adaptive browser size on: the caller passes the current display as its own maximum, so the
        // configured physical width is reported verbatim for every Android host.
        val authoritative = AirPlayDisplaySettings.resolvePhysicalSizeMm(
            currentWidthPixels = 1918,
            currentHeightPixels = 1200,
            maximumWidthPixels = 1918,
            maximumHeightPixels = 1200,
            referenceMillimeters = 300,
            basis = AirPlayPhysicalSizeBasis.WIDTH,
        )
        assertEquals(300, authoritative.widthMm)

        // A polluted per-phone history (e.g. a previously paired 2560-wide PC browser) would shrink
        // the reported width and make iPhone choose a different UI scale on another host.
        val polluted = AirPlayDisplaySettings.resolvePhysicalSizeMm(
            currentWidthPixels = 1918,
            currentHeightPixels = 1200,
            maximumWidthPixels = 2560,
            maximumHeightPixels = 1440,
            referenceMillimeters = 300,
            basis = AirPlayPhysicalSizeBasis.WIDTH,
        )
        assertEquals(225, polluted.widthMm)
    }
}
