package com.shilapi.xcertplay.web

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class CodecPacketTest {
    @Test fun headerCarriesSequencePtsFlagsAndPrependsParameterSetsOnKeyframes() {
        val au = byteArrayOf(0, 0, 0, 1, 0x65)
        val parameters = byteArrayOf(0, 0, 0, 1, 0x67, 1, 2, 3)
        val packet = CodecPacket.encode(7, 41000, true, au, parameters)
        val view = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(CodecPacket.MAGIC, view.int)
        assertEquals(7L, view.long)
        assertEquals(41000L, view.long)
        assertEquals(CodecPacket.FLAG_KEYFRAME.toShort(), view.short)
        assertEquals(parameters.size.toShort(), view.short)
        assertArrayEquals(parameters, packet.copyOfRange(CodecPacket.HEADER_BYTES, CodecPacket.HEADER_BYTES + parameters.size))
        assertArrayEquals(au, packet.copyOfRange(CodecPacket.HEADER_BYTES + parameters.size, packet.size))
    }

    @Test fun predictiveFramesCarryNoParameterSets() {
        val packet = CodecPacket.encode(8, 41333, false, byteArrayOf(1, 2), null)
        assertEquals(CodecPacket.HEADER_BYTES + 2, packet.size)
        val view = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN)
        view.int // magic
        view.long; view.long
        assertEquals(0.toShort(), view.short)
        assertEquals(0.toShort(), view.short)
    }
}
