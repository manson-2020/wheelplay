// SPDX-License-Identifier: AGPL-3.0-only
package moe.feng.wheelplay.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import com.shilapi.xcertplay.airplay.AirPlayDisplaySettings
import com.shilapi.xcertplay.host.R
import com.shilapi.xcertplay.web.ImageEncodingOptions
import com.shilapi.xcertplay.web.RtcRecoveryPolicy
import com.shilapi.xcertplay.web.StreamTechnology
import moe.feng.wheelplay.*

@Composable
internal fun DisplaySettingsScreen(state: SettingsState, actions: SettingsActions) {
    var editMargins by rememberSaveable { mutableStateOf(false) }
    var editWidth by rememberSaveable { mutableIntStateOf(1280) }
    var editHeight by rememberSaveable { mutableIntStateOf(720) }
    var editInitial by rememberSaveable { mutableStateOf(CarPlaySafeMargins().encode()) }
    var editLegacy by rememberSaveable { mutableStateOf(false) }
    val openSafeArea = {
        editWidth = state.safeAreaSlot.width
        editHeight = state.safeAreaSlot.height
        editInitial = (state.margins ?: state.legacyMargins ?: CarPlaySafeMargins()).encode()
        editLegacy = state.margins == null && state.legacySafeArea
        editMargins = true
    }
    SettingsGroup(R.string.settings_group_display_layout) {
        AppearanceSettings(state, actions)
        DisplaySizeSettings(state, actions, openSafeArea)
    }
    SettingsGroup(R.string.settings_group_streaming_quality) {
        StreamingSettings(state, actions)
    }
    if (editMargins)
        SafeAreaDialog(
            initial = requireNotNull(CarPlaySafeMargins.decode(editInitial)),
            slot = CarPlayResolutionSlot(editWidth, editHeight),
            legacy = editLegacy,
            onDismiss = { editMargins = false },
        ) {
            actions.margins(CarPlayResolutionSlot(editWidth, editHeight), it)
        }
}

/** What CarPlay looks like on either screen: mode, size, safe area and overlays. */
@Composable
private fun AppearanceSettings(state: SettingsState, actions: SettingsActions) {
    SettingsChoice(
        state,
        actions,
        ChoiceSetting.APPEARANCE,
        R.string.settings_appearance,
        CarPlayAppearance.entries.map { settingsString(it.labelRes) },
    )
    SettingsDescription(R.string.settings_appearance_description)
    SettingsChoice(
        state,
        actions,
        ChoiceSetting.DEFAULT_VIEW,
        R.string.settings_default_view,
        CarPlayDefaultView.entries.map { settingsString(it.labelRes) },
    )
    SettingsDescription(R.string.settings_default_view_description)
    SettingsToggle(
        state,
        actions,
        ToggleSetting.RIGHT_HAND,
        R.string.settings_right_hand,
        R.string.settings_right_hand_description,
    )
    SettingsToggle(
        state,
        actions,
        ToggleSetting.PHONE_STATUS_BADGE,
        R.string.settings_phone_status_badge,
        R.string.settings_phone_status_badge_description,
    )
}

/** Where CarPlay content sits on the head-unit viewport. */
@Composable
private fun DisplaySizeSettings(
    state: SettingsState,
    actions: SettingsActions,
    onEditMargins: () -> Unit,
) {
    SettingsSlider(
        title = R.string.settings_display_size,
        initial = state.displayWidthMm,
        range = AirPlayDisplaySettings.MIN_WIDTH_PHYSICAL_MM..AirPlayDisplaySettings.MAX_WIDTH_PHYSICAL_MM,
        step = AirPlayDisplaySettings.WIDTH_PHYSICAL_MM_STEP,
        tag = "slider:display-size",
        valueLabel = { "$it mm" },
        onCommit = actions.physicalWidth,
    )
    SettingsDescription(R.string.settings_display_size_description)
    val margins = state.margins
    val summary =
        if (margins == null && state.legacySafeArea)
            settingsString(R.string.settings_legacy_safe_area)
        else if (margins == null || margins.isFullScreen)
            settingsString(R.string.settings_fullscreen)
        else
            settingsString(
                R.string.settings_safe_area_value,
                margins.top,
                margins.bottom,
                margins.left,
                margins.right,
            )
    SettingsRow(settingsString(R.string.settings_safe_area), summary, "settings:safe-area") {
        onEditMargins()
    }
    Text(
        settingsString(
            R.string.settings_safe_area_slot,
            state.safeAreaSlot.width,
            state.safeAreaSlot.height,
        ),
        style = MaterialTheme.typography.bodySmall,
    )
    SettingsDescription(R.string.settings_safe_area_description)
}

/** How the picture is negotiated and encoded on its way to the browser. */
@Composable
private fun StreamingSettings(state: SettingsState, actions: SettingsActions) {
    SettingsToggle(
        state,
        actions,
        ToggleSetting.ADAPTIVE_SIZE,
        R.string.settings_adaptive_size,
        R.string.settings_adaptive_size_description,
    )
    SettingsChoice(
        state,
        actions,
        ChoiceSetting.RESOLUTION,
        R.string.settings_resolution,
        listOf(
            settingsString(R.string.settings_original_resolution),
            settingsString(R.string.settings_resolution_lower),
            settingsString(R.string.settings_resolution_lowest),
        ),
    )
    SettingsChoice(
        state,
        actions,
        ChoiceSetting.FPS,
        R.string.settings_fps,
        listOf(settingsString(R.string.settings_fps_30), settingsString(R.string.settings_fps_60)),
    )
    SettingsChoice(
        state,
        actions,
        ChoiceSetting.STREAM,
        R.string.settings_stream,
        StreamTechnology.entries.map { settingsString(it.labelRes) },
    )
    SettingsDescription(R.string.settings_stream_description)
    SettingsChoice(
        state, actions, ChoiceSetting.IMAGE_FORMAT, R.string.settings_image_format,
        listOf("JPEG", "WebP"),
    )
    SettingsDescription(R.string.settings_image_format_description)
    SettingsSlider(
        title = R.string.settings_image_quality,
        initial = state.imageQuality,
        // 5-point steps keep the head-unit thumb usable while keeping the default on the grid.
        range = 5..ImageEncodingOptions.QUALITY_RANGE.last,
        step = 5,
        tag = "slider:image-quality",
        valueLabel = { it.toString() },
        onCommit = { actions.text(TextSetting.IMAGE_QUALITY, it.toString()) },
    )
    SettingsDescription(R.string.settings_image_quality_description)
    SettingsToggle(
        state,
        actions,
        ToggleSetting.HEVC,
        R.string.settings_hevc,
        R.string.settings_hevc_description,
    )
    SettingsChoice(
        state,
        actions,
        ChoiceSetting.RECOVERY,
        R.string.settings_recovery,
        RtcRecoveryPolicy.entries.map { settingsString(it.labelRes) },
    )
    SettingsDescription(R.string.settings_recovery_description)
}
