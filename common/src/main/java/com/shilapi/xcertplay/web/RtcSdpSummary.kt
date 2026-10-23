package com.shilapi.xcertplay.web

/**
 * One-line SDP facts for host logs. Head units have no reachable console, so the phone keeps
 * the negotiation parameters it can see; credentials, ICE candidates and payloads never leave
 * this object.
 */
internal object RtcSdpSummary {
    data class Summary(
        val media: String,
        val codecs: String,
        val setup: String,
        val candidates: String,
        val profileLevelId: String?,
        /** Every negotiated media line, e.g. `video:1,application:1`. */
        val mediaLines: String = "",
    ) {
        /** True for Main/High H.264, which baseline-only head-unit decoders reject. */
        val mainOrHighProfile get() = profileLevelId?.let { it.startsWith("4d") || it.startsWith("64") } == true

        fun describe() =
            "media=$media codecs=$codecs setup=$setup candidates=$candidates" +
                if (mediaLines.isEmpty()) "" else " mlines=$mediaLines"
    }

    fun summarize(sdp: String?): Summary {
        val lines = sdp.orEmpty().lines().map { it.trim() }.filter { it.isNotEmpty() }
        val video = lines.firstOrNull { it.startsWith("m=video") }
        val fields = video?.removePrefix("m=video")?.trim()?.split(" ")?.filter { it.isNotEmpty() }.orEmpty()
        val media = if (fields.isEmpty()) "none" else "video:" + fields.first()
        // "m=video <port> <proto> <payload>...": the first payload type follows the protocol.
        val payload = fields.getOrNull(2)
        val rtpmap =
            lines.firstOrNull { it.startsWith("a=rtpmap:") && payload != null && it.removePrefix("a=rtpmap:").substringBefore(" ") == payload }
                ?.substringAfter(" ", "")
        val fmtp =
            lines.firstOrNull { it.startsWith("a=fmtp:") && payload != null && it.removePrefix("a=fmtp:").substringBefore(" ") == payload }
                ?.substringAfter(" ", "")
        val codecs =
            when {
                rtpmap.isNullOrEmpty() -> "none"
                fmtp.isNullOrEmpty() -> rtpmap
                else -> "$rtpmap $fmtp"
            }.take(200)
        val setup = lines.firstOrNull { it.startsWith("a=setup:") }?.removePrefix("a=setup:") ?: "none"
        var host = 0
        var srflx = 0
        var relay = 0
        var mdns = 0
        for (line in lines) {
            if (!line.startsWith("a=candidate:")) continue
            val parts = line.removePrefix("a=candidate:").split(" ").filter { it.isNotEmpty() }
            // Foundation, component, transport, priority, address, port, "typ", type, ...
            val address = parts.getOrNull(4)
            if (address != null && address.endsWith(".local", ignoreCase = true)) mdns++
            when (parts.getOrNull(7)) {
                "host" -> host++
                "srflx" -> srflx++
                "relay" -> relay++
            }
        }
        val profile = Regex("profile-level-id=([0-9a-fA-F]{6})").find(fmtp.orEmpty())?.groupValues?.getOrNull(1)?.lowercase()
        // An unexpected m=audio here is how a head unit ends up stealing the car's media audio.
        val kinds =
            lines.filter { it.startsWith("m=") }
                .map { it.removePrefix("m=").substringBefore(' ').ifEmpty { "application" } }
                .groupingBy { it }.eachCount()
        val mediaLines = kinds.entries.joinToString(",") { "${it.key}:${it.value}" }
        return Summary(media, codecs, setup, "host:$host,srflx:$srflx,relay:$relay,mdns:$mdns", profile, mediaLines)
    }
}
