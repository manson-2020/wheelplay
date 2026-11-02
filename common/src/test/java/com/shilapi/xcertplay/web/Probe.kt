package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.airplay.VideoCodec
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(RobolectricTestRunner::class)
class Probe {
    private val avcc = byteArrayOf(1, 0x64, 0, 0x20, -1, -31, 0, 4, 0x67, 0x64, 0, 0x20, 1, 0, 2, 0x68, 1)
    private val idr = byteArrayOf(0, 0, 0, 1, 0x65, 9, 9)
    private val delta = byteArrayOf(0, 0, 0, 1, 0x41, 7)

    @Test
    fun trace() {
        val source = WebVideoSource(StreamTechnology.WEBRTC).apply { configure(110, VideoCodec.H264, avcc) }
        val config = source.config!!
        val written = LinkedBlockingQueue<Int>()
        val keyframes = LinkedBlockingQueue<Unit>()
        source.recovery(110) { keyframes.offer(Unit); println("KF requested") }
        val rejected = AtomicBoolean(false)
        val stream = CodecVideoStream(source, config, RtcRecoveryPolicy.BALANCED,
            write = { packet ->
                val r = packet.size == CodecPacket.HEADER_BYTES + delta.size && rejected.compareAndSet(false, true)
                println("write size=" + packet.size + " rejected=" + r)
                if (!r) written.offer(packet.size)
                !r
            },
            failure = { println("FAIL: " + it) })
        check(source.attach(stream, config))
        stream.start()
        source.frame(110, idr, 1000)
        println("poll1=" + written.poll(5, TimeUnit.SECONDS))
        source.frame(110, delta, 41000)
        check(keyframes.poll(5, TimeUnit.SECONDS) != null)
        println("mid sent=" + stream.sentFrames + " snapshot=" + stream.snapshot()["queueFrames"] + "," + stream.snapshot()["keyframeSkips"])
        source.frame(110, idr, 82000)
        println("after idr2 offer sent=" + stream.sentFrames)
        source.frame(110, delta, 123000)
        println("after delta2 offer sent=" + stream.sentFrames)
        println("pollA=" + written.poll(5, TimeUnit.SECONDS))
        println("pollB=" + written.poll(1, TimeUnit.SECONDS))
        println("final sent=" + stream.sentFrames)
        stream.close()
    }
}
