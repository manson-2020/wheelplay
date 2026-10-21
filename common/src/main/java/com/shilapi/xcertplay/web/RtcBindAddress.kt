package com.shilapi.xcertplay.web

import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface

/**
 * ICE has to source its checks from the address the browser used. With a VPN alias such as the
 * Tesla compatibility address, a wildcard ICE socket answers from the hotspot address instead,
 * and the head unit drops the STUN response. Bind libjuice to the WebSocket host when it is one
 * of this device's IPv4 addresses; otherwise keep the default any-address behavior.
 */
internal object RtcBindAddress {
    private val ipv4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")

    fun forHost(host: String?, local: List<String> = localAddresses()): String? {
        val address = addressForHost(host, local) ?: return null
        // The interface can still advertise an address the socket layer refuses (VPN revoked,
        // route torn down between the handshake and the negotiation); fall back to the default.
        return runCatching {
            DatagramSocket(null).use { it.bind(InetSocketAddress(address, 0)) }
        }.map { address }.getOrNull()
    }

    /** Pure matching half; tests supply the interface list. */
    fun addressForHost(host: String?, local: List<String>): String? {
        val literal = literal(host) ?: return null
        val octets = literal.split(".")
        if (octets.size != 4 ||
            octets.any { value -> value.toIntOrNull()?.let { it !in 0..255 } != false }
        ) return null
        val parsed =
            runCatching {
                InetAddress.getByAddress(octets.map { it.toInt().toByte() }.toByteArray())
            }.getOrNull() as? Inet4Address ?: return null
        if (parsed.isLoopbackAddress || parsed.isLinkLocalAddress || parsed.isAnyLocalAddress)
            return null
        return local.firstOrNull { it.equals(parsed.hostAddress, ignoreCase = true) }
    }

    private fun literal(host: String?): String? {
        val raw = host?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val name =
            when {
                raw.startsWith("[") -> raw.substringAfter('[').substringBefore(']')
                raw.count { it == ':' } == 1 -> raw.substringBefore(':')
                else -> raw
            }
        // IPv4 literals only: a hostname would need DNS on the handshake thread and the ICE
        // socket cannot bind to a name anyway.
        return name.takeIf { ipv4.matches(it) }
    }

    private fun localAddresses(): List<String> =
        runCatching {
            java.util.Collections.list(NetworkInterface.getNetworkInterfaces())
                .filter { it.isUp && !it.isLoopback }
                .flatMap { java.util.Collections.list(it.inetAddresses) }
                .mapNotNull { it.hostAddress }
        }.getOrDefault(emptyList())
}
