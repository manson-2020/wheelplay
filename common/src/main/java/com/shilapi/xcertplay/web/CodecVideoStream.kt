package com.shilapi.xcertplay.web

import android.util.Log
import com.shilapi.xcertplay.media.CompressedVideoFrame
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The WebSocket codec stream: compressed H.264 access units pushed over the paired WebSocket and
 * decoded by the browser's WebCodecs. It exists for head units whose browser drops the phone's
 * Bluetooth audio link while a WebRTC media transport is active (docs/BROWSER_AUDIO.md); the queue,
 * keyframe recovery and stall detection mirror [RtcVideoStream] minus the native transport, and
 * decoded-frame feedback arrives once a second as `vcs-feedback`.
 */
internal class CodecVideoStream(
    private val source: WebVideoSource,
    private val config: WebVideoSource.Config,
    private val recovery: RtcRecoveryPolicy,
    private val write: (ByteArray) -> Boolean,
    private val failure: (retryable: Boolean) -> Unit,
    private val maxAgeNs: Long = 50_000_000,
) : VideoFrameStream {
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private val closed = AtomicBoolean(false)
    private val lock = Any()
    private val queue = RtcFrameQueue(maxAgeNs = maxAgeNs, recoveryGraceNs = recovery.graceMs * 1_000_000)
    private val performance = VideoPerformance()
    private val health = RtcReceiverHealth(recovery.graceMs)
    private var scheduled = false
    private var sequence = 0L
    private var ptsOrigin: Long? = null
    @Volatile var sentFrames = 0L
        private set
    @Volatile private var displayed = false
    val holdingFrame get() = displayed
    override val connected get() = !closed.get()

    fun start() {
        try { worker.schedule({ if (!closed.get() && !displayed) fail("first-frame timeout") }, recovery.firstFrameMs, TimeUnit.MILLISECONDS) }
        catch (_: RejectedExecutionException) { }
        // The first AU is not necessarily an IDR; the source forces one the same way it does for
        // a freshly connected WebRTC stream.
        source.requestKeyframe(force = true)
    }

    /** The browser drew its first decoded frame; still images can stop flowing. */
    fun displayed() {
        if (sentFrames > 0) { displayed = true; source.displayed(this) }
    }

    override fun frame(frame: CompressedVideoFrame, pts: Long) {
        if (closed.get()) return
        val idr = frame.isRandomAccess(config.codec)
        synchronized(lock) {
            if (closed.get()) return
            if (!queue.offer(frame, pts, idr, System.nanoTime(), if (idr) config.parameters.size else 0)) {
                if (queue.recoveryExpired(System.nanoTime())) execute {
                    val expired = synchronized(lock) { queue.recoveryExpired(System.nanoTime()) }
                    if (expired) fail("keyframe recovery timeout")
                }
                else if (queue.needsKeyframe) source.requestKeyframe()
                return
            }
            if (!scheduled) { scheduled = true; execute(::drain) }
        }
    }

    private fun drain() {
        repeat(6) {
            val next = synchronized(lock) {
                if (closed.get()) { scheduled = false; return }
                queue.poll(System.nanoTime()) ?: run {
                    scheduled = false
                    if (queue.needsKeyframe) source.requestKeyframe()
                    return
                }
            }
            performance.timing("queue", System.nanoTime() - next.queuedAtNs)
            if (ptsOrigin == null) ptsOrigin = next.pts
            val started = System.nanoTime()
            val bytes = next.data.toByteArray()
            val accepted = write(CodecPacket.encode(sequence++, next.pts - ptsOrigin!!, next.keyframe, bytes,
                if (next.keyframe) config.parameters else null))
            next.data.close()
            performance.timing("send", System.nanoTime() - started)
            if (accepted) { sentFrames++; performance.count("accepted") }
            else {
                performance.count("sendFailures")
                synchronized(lock) { queue.invalidate(System.nanoTime()) }
                source.requestKeyframe()
            }
        }
        execute(::drain)
    }

    /** The browser reports its decoded-frame count about once per second. */
    fun feedback(decoded: Long) = execute {
        val report = RtcReceiverHealth.Report(decoded, 0, decoded, 0, null)
        when (health.update(report, sentFrames, System.nanoTime() / 1_000_000)) {
            RtcReceiverHealth.Action.KEYFRAME -> source.requestKeyframe()
            RtcReceiverHealth.Action.FALLBACK -> fail("decoder recovery timeout")
            RtcReceiverHealth.Action.NONE -> Unit
        }
    }

    fun snapshot(): Map<String, Any?> = synchronized(lock) {
        mapOf("recoveryGraceMs" to recovery.graceMs, "sender" to performance.snapshot(),
            "queueFrames" to queue.size, "queueBytes" to queue.bytes,
            "expiredFrames" to queue.expired, "overflowFrames" to queue.overflow,
            "keyframeSkips" to queue.skipped)
    }

    private fun execute(task: () -> Unit) {
        if (closed.get()) return
        try { worker.execute {
            if (!closed.get()) try { task() }
            catch (error: Exception) { Log.w("WheelPlayWeb", "Codec stream failed; using JPEG", error); fail("transport exception") }
        } } catch (_: RejectedExecutionException) { }
    }

    private fun fail(reason: String, retryable: Boolean = true) {
        if (!closed.get()) {
            Log.w("WheelPlayWeb", "Using JPEG: $reason (grace=${recovery.graceMs}ms)")
            failure(retryable)
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        synchronized(lock) { queue.invalidate() }
        worker.shutdown()
    }
}
