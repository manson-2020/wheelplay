package com.shilapi.xcertplay.web

import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface

/**
 * ICE has to answer from the address the browser actually reached. A wildcard ICE socket replies
 * with whatever source the kernel prefers, and a browser discards a STUN response whose source
 * does not match the address it sent to. That is exactly what happens with a VPN alias such as
 * the Tesla compatibility address, so libjuice is bound to the accepted socket's local IPv4
 * address. Null keeps the previous any-address behaviour.
 */
internal object RtcBindAddress {
    private val ipv4 = Regex("""\d{1,3}(\.\d{1,3}){3}""")

    fun forAddress(address: String?, local: List<String> = localAddresses()): String? =
        addressForConnection(address, local)?.let(::bindable)

    /** Pure matching half; tests supply the interface list. */
    fun addressForConnection(address: String?, local: List<String>): String? {
        val parsed = literal(address) ?: return null
        return local.firstOrNull { it.equals(parsed.hostAddress, ignoreCase = true) }
    }

    /** IPv4 literals only; loopback and link-local addresses cannot reach a head unit. */
    private fun literal(text: String?): Inet4Address? {
        val raw = text?.trim() ?: return null
        if (!ipv4.matches(raw)) return null
        val octets = raw.split(".")
        if (octets.any { value -> value.toIntOrNull()?.let { it !in 0..255 } != false }) return null
        val parsed =
            runCatching {
                InetAddress.getByAddress(octets.map { it.toInt().toByte() }.toByteArray())
            }.getOrNull() as? Inet4Address ?: return null
        if (parsed.isLoopbackAddress || parsed.isLinkLocalAddress || parsed.isAnyLocalAddress)
            return null
        return parsed
    }

    // The interface can still advertise an address the socket layer refuses (VPN revoked, route
    // torn down between the handshake and the negotiation); keep the any-address default then.
    private fun bindable(address: String): String? =
        runCatching {
            DatagramSocket(null).use {
                it.bind(InetSocketAddress(InetAddress.getByName(address), 0))
            }
        }.map { address }.getOrNull()

    private fun localAddresses(): List<String> =
        runCatching {
            java.util.Collections.list(NetworkInterface.getNetworkInterfaces())
                .filter { it.isUp && !it.isLoopback }
                .flatMap { java.util.Collections.list(it.inetAddresses) }
                .mapNotNull { it.hostAddress }
        }.getOrDefault(emptyList())
}
