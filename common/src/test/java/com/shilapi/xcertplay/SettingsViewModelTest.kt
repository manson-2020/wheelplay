package com.shilapi.xcertplay

import androidx.lifecycle.SavedStateHandle
import com.shilapi.xcertplay.network.TeslaHttpConfig
import com.shilapi.xcertplay.network.TeslaHttpMode
import com.shilapi.xcertplay.settings.*
import com.shilapi.xcertplay.web.TeslaHttpCompatibility
import com.shilapi.xcertplay.web.WebSession
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class SettingsViewModelTest {
    private val app
        get() = RuntimeEnvironment.getApplication()

    @After
    fun cleanup() {
        WebSession.stop()
    }

    @Test
    fun restoredNavigationContainsScrollPositionsButNoCredentials() {
        val handle = SavedStateHandle()
        val model = SettingsViewModel(app, handle)
        model.saveCredentials(" CarPlay ", " password ")
        model.open(SettingsCategory.AUDIO)
        model.rememberScroll(null, 160)
        model.rememberScroll(SettingsCategory.AUDIO, 240)
        val saved = handle.keys().associateWith { handle.get<Any?>(it) }
        assertEquals(setOf("settingsCategory", "scroll:index", "scroll:AUDIO"), saved.keys)
        val restored = SettingsViewModel(app, SavedStateHandle(saved))
        assertEquals(SettingsCategory.AUDIO, restored.state.value.category)
        assertEquals(160, restored.scrollPosition(null))
        assertEquals(240, restored.scrollPosition(SettingsCategory.AUDIO))
        assertEquals(" CarPlay ", restored.state.value.ssid)
        assertEquals(" password ", restored.state.value.password)
    }

    @Test
    fun invalidCredentialsLeaveBothPersistedFieldsUntouched() {
        val model = SettingsViewModel(app, SavedStateHandle())
        model.saveCredentials(" Original ", " password ")
        assertTrue(runCatching { model.saveCredentials(" Changed ", "short") }.isFailure)
        assertEquals(" Original ", AirPlayPersistence.loadManualHotspotSsid(app))
        assertEquals(" password ", AirPlayPersistence.loadManualHotspotPassphrase(app))
        assertTrue(runCatching { model.saveCredentials("界".repeat(11), "otherpassword") }.isFailure)
        assertEquals(" Original ", model.state.value.ssid)
    }

    @Test
    fun mediaSettingsKeepMicrophoneDisabledAndRequestTheAppropriateEffects() {
        val model = SettingsViewModel(app, SavedStateHandle())
        assertTrue(
            model.choose(ChoiceSetting.MICROPHONE, CarPlayMicrophoneSource.DISABLED.ordinal)
                is SettingsEffect.Reconnect
        )
        model.choose(ChoiceSetting.AUDIO_BUFFER, 2)
        assertEquals(SettingsEffect.None, model.choose(ChoiceSetting.AUDIO_OUTPUT, 1))
        assertEquals(CarPlayMicrophoneSource.DISABLED, AirPlayPersistence.loadMicrophoneSource(app))
        assertEquals(
            CarPlayMicrophoneSource.DISABLED.ordinal,
            model.state.value.selected(ChoiceSetting.MICROPHONE),
        )
        assertEquals(SettingsEffect.None, model.choose(ChoiceSetting.LOCATION, 1))
        assertTrue(AirPlayPersistence.loadLocationReportingEnabled(app))
    }

    @Test
    fun keepScreenOnDefaultsToEnabledAndPersistsToggleChanges() {
        val model = SettingsViewModel(app, SavedStateHandle())
        assertTrue(model.state.value.checked(ToggleSetting.KEEP_SCREEN_ON))
        assertEquals(
            SettingsEffect.KeepScreenOnEnabled(false),
            model.toggle(ToggleSetting.KEEP_SCREEN_ON, false),
        )
        assertFalse(DiPlayPreferences.keepScreenOn(app))
        assertFalse(model.state.value.checked(ToggleSetting.KEEP_SCREEN_ON))
        model.toggle(ToggleSetting.KEEP_SCREEN_ON, true)
        assertTrue(DiPlayPreferences.keepScreenOn(app))
    }

    @Test
    fun defaultViewRecordsBrowserSizeAndPhoneSizeAsTheDefaultCanvas() {
        val model = SettingsViewModel(app, SavedStateHandle())
        model.choose(ChoiceSetting.DEFAULT_VIEW, CarPlayDefaultView.PHONE_DISPLAY.ordinal)
        assertEquals(CarPlayPhoneDisplay.landscapeDp(app), AirPlayPersistence.loadDefaultDisplaySize(app))
        // The phone view also records the physical-pixel twin the on-phone preview negotiates.
        assertEquals(
            CarPlayPhoneDisplay.landscapePx(app),
            AirPlayPersistence.loadDefaultDisplayPxSize(app),
        )
        model.choose(ChoiceSetting.DEFAULT_VIEW, CarPlayDefaultView.BROWSER_STREAM.ordinal)
        assertEquals(
            AirPlayPersistence.BROWSER_DEFAULT_DISPLAY_WIDTH to AirPlayPersistence.BROWSER_DEFAULT_DISPLAY_HEIGHT,
            AirPlayPersistence.loadDefaultDisplaySize(app),
        )
        // The browser view keeps no px twin, so the browser path never sees a phone-sized canvas.
        assertNull(AirPlayPersistence.loadDefaultDisplayPxSize(app))
    }

    @Test
    fun defaultViewDefaultsToBrowserStreamAndPersistsPhoneSelection() {
        val model = SettingsViewModel(app, SavedStateHandle())
        assertEquals(
            CarPlayDefaultView.BROWSER_STREAM.ordinal,
            model.state.value.selected(ChoiceSetting.DEFAULT_VIEW),
        )
        assertEquals(SettingsEffect.None, model.choose(ChoiceSetting.DEFAULT_VIEW, CarPlayDefaultView.PHONE_DISPLAY.ordinal))
        assertEquals(CarPlayDefaultView.PHONE_DISPLAY, AirPlayPersistence.loadDefaultView(app))
        assertEquals(
            CarPlayDefaultView.PHONE_DISPLAY.ordinal,
            model.state.value.selected(ChoiceSetting.DEFAULT_VIEW),
        )
    }

    @Test
    fun changingTeslaModeDisablesThePreviousRouteAndRejectsInvalidPorts() {
        TeslaHttpCompatibility.save(app, TeslaHttpConfig(enabled = true))
        val model = SettingsViewModel(app, SavedStateHandle())
        model.choose(ChoiceSetting.TESLA_MODE, TeslaHttpMode.VPN.ordinal)
        assertFalse(TeslaHttpCompatibility.config(app).enabled)
        assertEquals(TeslaHttpMode.VPN, model.state.value.tesla.mode)
        assertTrue(runCatching { model.edit(TextSetting.HTTP_PORT, "80") }.isFailure)
        assertEquals(8080, model.state.value.httpPort)
        val update = model.edit(TextSetting.HTTP_PORT, "9090") as SettingsEffect.WebUpdate
        assertNull(update.operation())
        model.reload()
        assertEquals(9090, model.state.value.httpPort)
    }
}
