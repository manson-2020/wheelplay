// SPDX-License-Identifier: AGPL-3.0-only
package moe.feng.wheelplay.settings

import androidx.compose.runtime.Composable
import com.shilapi.xcertplay.host.R

/**
 * Everything about reaching this device from the head-unit browser: the listeners that serve the
 * page, and the optional routing proxy for browsers that block private network addresses.
 */
@Composable
internal fun NetworkSettingsScreen(state: SettingsState, actions: SettingsActions) {
    SettingsGroup(R.string.settings_web_listeners) { WebListenerSettings(state, actions) }
    SettingsGroup(R.string.settings_routing_proxy) { RoutingProxySettings(state, actions) }
}
