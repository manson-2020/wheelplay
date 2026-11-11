// SPDX-License-Identifier: AGPL-3.0-only
package moe.feng.wheelplay.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.shilapi.xcertplay.airplay.AirPlayDisplaySettings
import com.shilapi.xcertplay.host.R
import com.shilapi.xcertplay.web.ImageEncodingOptions
import com.shilapi.xcertplay.web.RtcRecoveryPolicy
import com.shilapi.xcertplay.web.StreamTechnology
import java.text.DateFormat
import java.util.Date
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
    SettingsGroup(R.string.settings_group_head_unit_screen) {
        HeadUnitScreenSettings(state, actions)
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

/**
 * The head-unit screens we have connected to, in the same shape as iOS's "CarPlay 画面 → 车机屏幕"
 * list: resolution · ratio, simulated width and density, and the last connection time. The checked
 * row is the canvas the next launch starts with. Tap to pin it, swipe (or use the trash button) to
 * remove it. Before the first connection the factory preset is shown as a never-used row.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HeadUnitScreenSettings(state: SettingsState, actions: SettingsActions) {
    val screens = state.headUnitScreens.ifEmpty { listOf(CarPlayScreenMemory.preset()) }
    val dateFormat = remember { DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT) }
    Card(
        Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
    ) {
        Column {
            screens.forEachIndexed { index, screen ->
                key(screen.key) {
                    if (index > 0) {
                        Box(
                            Modifier.fillMaxWidth()
                                .height(1.dp)
                                .background(MaterialTheme.colorScheme.outlineVariant),
                        )
                    }
                    val removable = !screen.neverUsed
                    val dismissState = rememberSwipeToDismissBoxState()
                    // A completed swipe removes the record; the reload from the action disposes
                    // this row, so there is no half-dismissed item left behind.
                    LaunchedEffect(dismissState.currentValue) {
                        if (dismissState.currentValue == SwipeToDismissBoxValue.EndToStart) {
                            actions.removeScreen(screen.key)
                        }
                    }
                    SwipeToDismissBox(
                        state = dismissState,
                        enableDismissFromStartToEnd = false,
                        enableDismissFromEndToStart = removable,
                        backgroundContent = {
                            Box(
                                Modifier.fillMaxSize()
                                    .background(MaterialTheme.colorScheme.errorContainer)
                                    .padding(end = 20.dp),
                                contentAlignment = Alignment.CenterEnd,
                            ) {
                                Icon(
                                    painterResource(R.drawable.ic_settings_delete),
                                    settingsString(R.string.settings_head_unit_screen_delete),
                                    tint = MaterialTheme.colorScheme.onErrorContainer,
                                )
                            }
                        },
                    ) {
                        Row(
                            Modifier.fillMaxWidth()
                                .background(MaterialTheme.colorScheme.surfaceContainer)
                                .testTag("screen:${screen.key}")
                                .clickable(enabled = removable, role = Role.Button) {
                                    actions.selectScreen(screen.key)
                                }
                                .padding(horizontal = 16.dp, vertical = 14.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    settingsString(
                                        R.string.settings_head_unit_screen_size,
                                        screen.width,
                                        screen.height,
                                        screen.aspectRatio,
                                    ),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Text(
                                    settingsString(
                                        R.string.settings_head_unit_screen_metrics,
                                        screen.widthPhysicalMm,
                                        screen.dpi,
                                    ),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                Text(
                                    if (screen.neverUsed)
                                        settingsString(R.string.settings_head_unit_screen_preset)
                                    else
                                        settingsString(
                                            R.string.settings_head_unit_screen_last_used,
                                            dateFormat.format(Date(screen.lastUsedAt)),
                                        ),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (screen.key == state.headUnitDefaultKey) {
                                Icon(
                                    painterResource(R.drawable.ic_settings_check),
                                    settingsString(R.string.settings_head_unit_screen_default),
                                    tint = MaterialTheme.colorScheme.primary,
                                )
                            }
                            if (removable) {
                                IconButton(
                                    onClick = { actions.removeScreen(screen.key) },
                                    modifier = Modifier.testTag("screen-delete:${screen.key}"),
                                ) {
                                    Icon(
                                        painterResource(R.drawable.ic_settings_delete),
                                        settingsString(R.string.settings_head_unit_screen_remove),
                                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    SettingsDescription(R.string.settings_head_unit_screen_description)
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
