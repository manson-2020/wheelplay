// SPDX-License-Identifier: AGPL-3.0-only
package com.shilapi.xcertplay

import com.shilapi.xcertplay.airplay.AirPlayDisplaySettings
import com.shilapi.xcertplay.airplay.CarPlayDisplayScale
import com.shilapi.xcertplay.network.TeslaHttpConfig
import com.shilapi.xcertplay.network.TeslaHttpMode
import com.shilapi.xcertplay.web.ImageFormat
import com.shilapi.xcertplay.web.RtcRecoveryPolicy
import com.shilapi.xcertplay.web.StreamTechnology
import com.shilapi.xcertplay.web.TeslaHttpCompatibility
import com.shilapi.xcertplay.web.WebListenSettings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * Pins the configuration a fresh install starts from. Every value here is what the settings pages
 * should show before the user touches anything, so a new install needs no manual setup.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class ShippedDefaultsTest {
    private val app get() = RuntimeEnvironment.getApplication()

    @Test
    fun connectionDefaults() {
        assertTrue(DiPlayPreferences.autoConnect(app))
        assertTrue(AirPlayPersistence.loadAutoStartOnBoot(app))
        assertTrue(DiPlayPreferences.keepScreenOn(app))
        // Wi-Fi Direct stays the default: the device-hotspot mode needs this phone's own SSID and
        // password, which cannot ship as a default.
        assertEquals(
            com.shilapi.xcertplay.orchestration.WirelessHotspotMode.WIFI_P2P,
            AirPlayPersistence.loadWirelessHotspotMode(app),
        )
    }

    @Test
    fun displayAndStreamDefaults() {
        assertEquals(CarPlayAppearance.FOLLOW_DISPLAY, AirPlayPersistence.loadAppearance(app))
        assertEquals(CarPlayDefaultView.BROWSER_STREAM, AirPlayPersistence.loadDefaultView(app))
        assertFalse(AirPlayPersistence.loadRightHandDrive(app))
        assertTrue(AirPlayPersistence.loadPhoneStatusBadge(app))
        assertEquals(250, AirPlayPersistence.loadWidthPhysicalMm(app))
        assertTrue(AirPlayPersistence.loadAdaptiveBrowserSize(app))
        assertEquals(CarPlayDisplayScale.MAX_TENTHS, AirPlayPersistence.loadDisplayScaleTenths(app))
        assertEquals(AirPlayDisplaySettings.MAX_FPS, AirPlayPersistence.loadFps(app))
        assertEquals(StreamTechnology.WEBCODECS, AirPlayPersistence.loadStreamTechnology(app))
        assertEquals(ImageFormat.JPEG, AirPlayPersistence.loadImageFormat(app))
        assertEquals(90, AirPlayPersistence.loadImageQuality(app))
        assertEquals(RtcRecoveryPolicy.BALANCED, AirPlayPersistence.loadRtcRecoveryPolicy(app))
        assertTrue(AirPlayPersistence.loadHevcEnabled(app))
        assertFalse(AirPlayPersistence.loadHevcUnusable(app))
        assertNull(AirPlayPersistence.loadSafeMargins(app))
    }

    @Test
    fun audioVehicleAndBrowserDefaults() {
        assertEquals(300, AirPlayPersistence.loadMediaBufferMillis(app))
        assertFalse(AirPlayPersistence.loadBrowserAudioPlayback(app))
        assertTrue(AirPlayPersistence.loadBrowserMediaToPage(app))
        assertEquals(CarPlayMicrophoneSource.ANDROID, AirPlayPersistence.loadMicrophoneSource(app))
        assertFalse(AirPlayPersistence.loadLocationReportingEnabled(app))
        assertEquals(AirPlayPersistence.DEFAULT_SIMULATED_MANUFACTURER_NAME,
            AirPlayPersistence.loadSimulatedManufacturerName(app))
        assertEquals(BrowserOfflinePolicy.KEEP, AirPlayPersistence.loadBrowserOfflinePolicy(app))
    }

    @Test
    fun networkAndRoutingProxyDefaults() {
        assertEquals(8080, WebListenSettings.httpPort(app))
        assertEquals(8443, WebListenSettings.httpsPort(app))
        assertTrue(WebListenSettings.httpsEnabled(app))
        assertEquals("", WebListenSettings.hostname(app))
        assertEquals(WebListenSettings.DEFAULT_MDNS_HOSTNAME, WebListenSettings.mdnsHostname(app))
        assertEquals(
            TeslaHttpConfig(enabled = true, mode = TeslaHttpMode.VPN),
            TeslaHttpCompatibility.config(app),
        )
        assertEquals(TeslaHttpConfig.DEFAULT_VPN_ADDRESS, TeslaHttpCompatibility.config(app).accessAddress)
    }
}
