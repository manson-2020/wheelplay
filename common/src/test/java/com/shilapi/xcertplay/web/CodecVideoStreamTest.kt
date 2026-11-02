package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.airplay.VideoCodec
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** The WebSocket codec stream against a real [WebVideoSource]; recovery timing stays in health tests. */
@RunWith(RobolectricTestRunner::class)
class CodecVideoStreamTest {
    private val avcc = byteArrayOf(1, 0x64, 0, 0x20, -1, -31, 0, 4, 0x67, 0x64, 0, 0x20, 1, 0, 2, 0x68, 1)
    private val idr = byteArrayOf(0, 0, 0, 1, 0x65, 9, 9)
    private val delta = byteArrayOf(0, 0, 0, 1, 0x41, 7)

    private fun source(): WebVideoSource = WebVideoSource(StreamTechnology.WEBRTC).apply {
        configure(110, VideoCodec.H264, avcc)
    }

    @Test
    fun framesFlowAsAnnexBPacketsWithParameterSetsOnlyOnKeyframes() {
        val source = source()
        val config = source.config!!
        val written = LinkedBlockingQueue<ByteArray>()
        val stream = CodecVideoStream(source, config, RtcRecoveryPolicy.BALANCED,
            write = { packet -> written.offer(packet); true },
            failure = { fail("a healthy stream must not fail: $it") }, maxAgeNs = 10_000_000_000)
        assertTrue(source.attach(stream, config))
        assertTrue(source.jpegNeeded)
        stream.start()
        source.frame(110, idr, 1000)
        source.frame(110, delta, 41000)
        val keyframe = written.poll(5, TimeUnit.SECONDS)!!
        val predictive = written.poll(5, TimeUnit.SECONDS)!!
        fun flags(packet: ByteArray) = ByteBuffer.wrap(packet).order(ByteOrder.LITTLE_ENDIAN).let {
            it.position(20); it.short to it.short
        }
        assertEquals(CodecPacket.FLAG_KEYFRAME.toShort() to config.parameters.size.toShort(), flags(keyframe))
        // The Annex B payload of a keyframe carries the parameter sets before the access unit.
        assertEquals((CodecPacket.HEADER_BYTES + config.parameters.size + idr.size).toLong(), keyframe.size.toLong())
        assertEquals(0.toShort() to 0.toShort(), flags(predictive))
        assertEquals((CodecPacket.HEADER_BYTES + delta.size).toLong(), predictive.size.toLong())
        assertEquals(2L, stream.sentFrames)
        stream.displayed()
        assertFalse(source.jpegNeeded)
        source.detach(stream)
        assertTrue(source.jpegNeeded)
    }

    @Test
    fun aRejectedWriteDropsTheReferenceChainAndAsksForAKeyframe() {
        val source = source()
        val config = source.config!!
        val written = LinkedBlockingQueue<ByteArray>()
        val keyframes = LinkedBlockingQueue<Unit>()
        // Reject exactly one write by packet shape (a predictive AU is always 30 bytes here) so the
        // decision does not depend on cross-thread visibility of a test-side flag.
        val rejected = java.util.concurrent.atomic.AtomicBoolean(false)
        val stream = CodecVideoStream(source, config, RtcRecoveryPolicy.BALANCED,
            write = { packet ->
                if (packet.size == CodecPacket.HEADER_BYTES + delta.size && rejected.compareAndSet(false, true)) false
                else { written.offer(packet); true }
            },
            failure = { fail("queue backpressure recovers, it must not fail the stream") },
            maxAgeNs = 10_000_000_000)
        assertTrue(source.attach(stream, config))
        stream.start()
        // Registered after start(): the start-up keyframe request fires before this, so the queue
        // below only receives the request that the rejected write itself triggers.
        source.recovery(110) { keyframes.offer(Unit) }
        source.frame(110, idr, 1000)
        assertNotNull(written.poll(5, TimeUnit.SECONDS))
        // The source rate-limits keyframe requests to one per 500 ms and start() already used the
        // window; wait it out so the rejected write's own request is not silently dropped.
        Thread.sleep(600)
        source.frame(110, delta, 41000)
        assertEquals("backpressure must request a keyframe", Unit, keyframes.poll(5, TimeUnit.SECONDS))
        assertEquals(1L, stream.sentFrames)
        // The next keyframe goes through again and predictive frames resume behind it.
        source.frame(110, idr, 82000)
        source.frame(110, delta, 123000)
        // The rejected delta never comes back; the fresh keyframe and its predictive frame both go.
        assertNotNull(written.poll(5, TimeUnit.SECONDS))
        assertNotNull(written.poll(5, TimeUnit.SECONDS))
        assertEquals(3L, stream.sentFrames)
        stream.close()
    }
}
