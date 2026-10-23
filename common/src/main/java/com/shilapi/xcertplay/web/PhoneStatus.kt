// SPDX-License-Identifier: AGPL-3.0-only
package com.shilapi.xcertplay.web

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.telephony.TelephonyManager
import kotlin.math.roundToInt

/**
 * This Android phone's own battery, media volume and uplink, forwarded to the head unit as the corner
 * gauge over the CarPlay picture. The status bar Apple draws belongs to the iPhone in the passenger's
 * pocket, so the device actually carrying the stream - and the hotspot or VPN that can silently drain
 * it - needs its own reading. Values travel inside the existing `ping` reply, not a second socket.
 */
internal object PhoneStatus {
    /** The browser pings every 400 ms; neither the radio nor the battery moves that fast. */
    private const val CACHE_MILLIS = 2_000L
    /** `NetworkCapabilities.SIGNAL_STRENGTH_UNSPECIFIED`, spelled out to stay off an API 29 field. */
    private const val SIGNAL_UNSPECIFIED = Int.MIN_VALUE
    /** Below this the badge turns red, the same threshold the platform battery warning uses. */
    const val LOW_BATTERY_PERCENT = 20
    // A live data connection whose level the platform will not share still has a connection: an empty
    // gauge would read as "no signal" to the driver, which is the opposite of the truth.
    private const val BARS_UNKNOWN = 4

    data class Snapshot(
        val battery: Int,
        val charging: Boolean,
        val volume: Int,
        val network: String,
        val bars: Int,
    )

    @Volatile private var cachedAt = 0L
    @Volatile private var cached: Snapshot? = null

    /** Battery, media volume and uplink of this phone; a -1 and the network "none" mean "unreadable". */
    fun snapshot(context: Context): Snapshot {
        val now = SystemClock.elapsedRealtime()
        cached?.takeIf { now - cachedAt < CACHE_MILLIS }?.let { return it }
        val (battery, charging) = batteryLevel(context)
        val (network, bars) = uplink(context)
        return Snapshot(battery, charging, mediaVolumePercent(context), network, bars).also {
            cached = it
            cachedAt = now
        }
    }

    /** The sticky battery broadcast: no receiver registration and no permission required. */
    private fun batteryLevel(context: Context): Pair<Int, Boolean> {
        val intent = runCatching {
            context.registerReceiver(null as BroadcastReceiver?, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        }.getOrNull() ?: return -1 to false
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 0)
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        return percent(level, scale) to
            (plugged != 0 || status == BatteryManager.BATTERY_STATUS_CHARGING)
    }

    /**
     * The ring the gauge fills with its right-hand arc. Media volume is what the driver actually
     * hears, and reading it needs no permission; the stream scale differs per device, so it travels
     * as a percentage.
     */
    private fun mediaVolumePercent(context: Context): Int {
        val manager = runCatching {
            context.getSystemService(AudioManager::class.java)
        }.getOrNull() ?: return -1
        val stream = runCatching { manager.getStreamVolume(AudioManager.STREAM_MUSIC) }.getOrDefault(-1)
        val max = runCatching { manager.getStreamMaxVolume(AudioManager.STREAM_MUSIC) }.getOrDefault(0)
        return volumePercent(stream, max)
    }

    /**
     * The transport carrying the phone's internet. A VPN tunnel - the tethering and Tesla helpers both
     * can install one - hides the radio underneath it, so the badge reports the physical uplink instead
     * of the virtual interface the head unit is not connected through.
     */
    private fun uplink(context: Context): Pair<String, Int> {
        val manager = runCatching { context.getSystemService(ConnectivityManager::class.java) }.getOrNull()
            ?: return "none" to 0
        val active = runCatching { manager.activeNetwork }.getOrNull()
        val capabilities = active?.let { runCatching { manager.getNetworkCapabilities(it) }.getOrNull() }
        if (capabilities != null && !capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) {
            return describe(context, capabilities)
        }
        val physical = runCatching {
            manager.allNetworks
                .mapNotNull { network ->
                    val caps = runCatching { manager.getNetworkCapabilities(network) }.getOrNull() ?: return@mapNotNull null
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN) ||
                        !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                    ) {
                        return@mapNotNull null
                    }
                    network to caps
                }
                // allNetworks has no documented order, so the radio a driver expects to see wins:
                // the Wi-Fi a head unit usually reaches the phone over, then the cellular data line.
                .mapNotNull { (network, caps) -> rank(caps)?.let { Triple(network, caps, it) } }
                .minByOrNull { (_, _, order) -> order }
        }.getOrNull() ?: return "none" to 0
        return describe(context, physical.second)
    }

    /** Preference order for a physical uplink, or null when the network is none of them. */
    private fun rank(capabilities: NetworkCapabilities): Int? =
        when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> 0
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> 1
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> 2
            else -> null
        }

    private fun describe(context: Context, capabilities: NetworkCapabilities): Pair<String, Int> =
        when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) ->
                "wifi" to wifiBars(signalStrength(capabilities))

            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) ->
                generation(radioType(context)) to cellularBars(radioLevel(context))

            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) ->
                "eth" to BARS_UNKNOWN

            else -> "none" to 0
        }

    /** `NetworkCapabilities` only carries a level from API 29, and it is Wi-Fi specific. */
    private fun signalStrength(capabilities: NetworkCapabilities): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) capabilities.signalStrength else -1

    /**
     * The radio technology behind a cellular data connection, e.g. `NETWORK_TYPE_NR`. Reading it needs
     * the normal-protection `READ_BASIC_PHONE_STATE` (API 33+), so older releases fall back to a plain
     * "cellular" label instead of asking the user for the dangerous phone-state permission.
     */
    private fun radioType(context: Context): Int {
        val manager = telephony(context) ?: return TelephonyManager.NETWORK_TYPE_UNKNOWN
        return runCatching { manager.dataNetworkType }.getOrDefault(TelephonyManager.NETWORK_TYPE_UNKNOWN)
    }

    private fun radioLevel(context: Context): Int {
        val manager = telephony(context) ?: return -1
        // No permission is required, but a device without FEATURE_TELEPHONY_RADIO_ACCESS throws.
        return runCatching { manager.signalStrength?.level }.getOrNull() ?: -1
    }

    private fun telephony(context: Context): TelephonyManager? = runCatching {
        context.getSystemService(TelephonyManager::class.java)
    }.getOrNull()

    /** Wi-Fi RSSI in dBm to the four bars a status bar draws; an unreadable level is reported full. */
    fun wifiBars(rssi: Int): Int =
        when {
            rssi == SIGNAL_UNSPECIFIED || rssi >= 0 -> BARS_UNKNOWN
            rssi >= -55 -> 4
            rssi >= -67 -> 3
            rssi >= -77 -> 2
            rssi >= -85 -> 1
            else -> 0
        }

    /** `SignalStrength.getLevel()` already spans 0..4. */
    fun cellularBars(level: Int): Int =
        if (level < 0) BARS_UNKNOWN else level.coerceAtMost(4)

    fun percent(level: Int, scale: Int): Int =
        if (level < 0 || scale <= 0) -1 else (level * 100.0 / scale).roundToInt().coerceIn(0, 100)

    /** Same ratio as [percent], spelled out for the media stream so the gauge reads 0..100. */
    fun volumePercent(stream: Int, max: Int): Int = percent(stream, max)

    /** The generation label the badge prints, matching Apple's own status-bar abbreviations. */
    fun generation(type: Int): String =
        when (type) {
            TelephonyManager.NETWORK_TYPE_NR -> "5g"
            TelephonyManager.NETWORK_TYPE_LTE -> "4g"

            TelephonyManager.NETWORK_TYPE_UMTS,
            TelephonyManager.NETWORK_TYPE_HSDPA,
            TelephonyManager.NETWORK_TYPE_HSUPA,
            TelephonyManager.NETWORK_TYPE_HSPA,
            TelephonyManager.NETWORK_TYPE_HSPAP,
            TelephonyManager.NETWORK_TYPE_EVDO_0,
            TelephonyManager.NETWORK_TYPE_EVDO_A,
            TelephonyManager.NETWORK_TYPE_EVDO_B,
            TelephonyManager.NETWORK_TYPE_EHRPD,
            TelephonyManager.NETWORK_TYPE_TD_SCDMA,
            -> "3g"

            TelephonyManager.NETWORK_TYPE_GPRS,
            TelephonyManager.NETWORK_TYPE_EDGE,
            TelephonyManager.NETWORK_TYPE_CDMA,
            TelephonyManager.NETWORK_TYPE_1xRTT,
            TelephonyManager.NETWORK_TYPE_IDEN,
            TelephonyManager.NETWORK_TYPE_GSM,
            -> "2g"

            else -> "cellular"
        }
}
