package com.shilapi.xcertplay.web

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * One compressed access unit of the WebSocket codec stream. The browser decodes it with WebCodecs,
 * so unlike [VideoPacket] this carries the encoder's own bytes instead of a still image: Annex B
 * payload, with the codec's parameter sets prepended on keyframes exactly like the WebRTC sender.
 */
internal object CodecPacket {
    const val MAGIC = 0x31564357 // WCV1; distinct from WPV2/WPV3 images and the WPA1 audio header
    const val HEADER_BYTES = 24
    const val FLAG_KEYFRAME = 1

    fun encode(sequence: Long, ptsUs: Long, keyframe: Boolean, au: ByteArray, parameters: ByteArray?): ByteArray {
        val parameterBytes = if (keyframe) parameters?.size ?: 0 else 0
        require(parameterBytes == 0 || parameters != null)
        return ByteBuffer.allocate(HEADER_BYTES + parameterBytes + au.size)
            .order(ByteOrder.LITTLE_ENDIAN)
            .putInt(MAGIC)
            // JS reads these with getBigInt64; a session's pts and sequence never overflow it.
            .putLong(sequence).putLong(ptsUs)
            .putShort((if (keyframe) FLAG_KEYFRAME else 0).toShort()).putShort(parameterBytes.toShort())
            .apply { if (parameterBytes > 0) put(parameters) }
            .put(au)
            .array()
    }
}
