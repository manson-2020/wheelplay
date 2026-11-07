package com.shilapi.xcertplay.network

import android.content.Context
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.wifi.WifiManager

/**
 * Reads whether the head unit's own Wi-Fi hotspot is on, for the "Car hotspot" link.
 *
 * DiPlay does not turn the hotspot on itself: that needs a permission Android only grants over
 * ADB. The user turns it on in the car settings, or automates it with a tool such as BYDMate.
 */
object CarHotspotStatus {
    private const val WIFI_AP_STATE_ENABLED = 13

    // Huawei/Honor run the tethering hotspot on p2pN and never start the AOSP SoftApManager, so
    // WifiManager's legacy AP state stays DISABLED while the hotspot serves clients. Hotspot
    // interface names seen in the wild: wlanN (STA+AP), swlanN, softapN, apN, ap_br_*, p2pN.
    // p2pN matches digits only, so Wi-Fi Direct groups (p2p-p2pN-…) are never mistaken for one.
    private val HOTSPOT_IFACE = Regex(
        "wlan\\d+|swlan\\d+|softap\\d*|ap_br_\\w+|ap\\d+|p2p\\d+",
        RegexOption.IGNORE_CASE,
    )

    /**
     * True/false from the Wi-Fi AP state cross-checked against the tethering stack, or null when
     * the firmware hides both (then callers must not block the connection). Interface flags alone
     * are not used: BYD keeps wlan1 up with an address while tethering is off.
     */
    fun isEnabled(context: Context): Boolean? {
        val wifi = context.applicationContext.getSystemService(WifiManager::class.java) ?: return null
        val apState = runCatching {
            WifiManager::class.java.getMethod("getWifiApState").invoke(wifi) as Int == WIFI_AP_STATE_ENABLED
        }.recoverCatching {
            WifiManager::class.java.getMethod("isWifiApEnabled").invoke(wifi) as Boolean
        }.getOrNull()
        return hotspotOn(apState, tetheredInterfaces(context))
    }

    /**
     * Legacy AP state first: [true] and unobservable ([null]) behave as before. A definitive
     * [false] is only trusted when the tethering stack confirms there is no wireless downstream -
     * on ROMs that track the hotspot purely in the tethering stack the legacy state lies.
     */
    internal fun hotspotOn(legacyState: Boolean?, tethered: List<String>?): Boolean? = when {
        legacyState != false -> legacyState
        tethered == null -> false
        else -> tethered.any { HOTSPOT_IFACE.matches(it) }
    }

    /**
     * Tethered interface names, or null when neither source is available. The reflection path is
     * synchronous and works where the legacy AP state does not (Huawei p2pN hotspots); the sticky
     * TETHER_STATE_CHANGED broadcast is the same source TeslaHttpCompatibility uses.
     */
    internal fun tetheredInterfaces(context: Context): List<String>? {
        val application = context.applicationContext
        val connectivity = application.getSystemService(ConnectivityManager::class.java)
        val reflected = runCatching {
            ConnectivityManager::class.java.getMethod("getTetheredIfaces")
                .invoke(connectivity) as Array<*>
        }.getOrNull()?.filterIsInstance<String>()
        if (reflected != null) return reflected
        val sticky = runCatching {
            application.registerReceiver(null, IntentFilter("android.net.conn.TETHER_STATE_CHANGED"))
        }.getOrNull() ?: return null
        return sticky.getStringArrayListExtra("tetherArray")
            ?: sticky.getStringArrayExtra("tetherArray")?.toList().orEmpty()
    }
}
