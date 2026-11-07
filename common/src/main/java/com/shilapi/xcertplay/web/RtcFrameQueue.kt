package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.media.CompressedVideoFrame
import com.shilapi.xcertplay.media.HeapVideoFrame

/** Caller holds the media queue lock. Predictive frames are never retained across a gap. */
internal class RtcFrameQueue(
    private val maxAgeNs: Long = 50_000_000,
    private val maxBytes: Int = 2 * 1024 * 1024,
    private val maxFrames: Int = 6,
    private val recoveryGraceNs: Long = RtcRecoveryPolicy.BALANCED.graceMs * 1_000_000,
) {
    data class Frame(val data: CompressedVideoFrame, val pts: Long, val queuedAtNs: Long, val keyframe: Boolean, val cost: Int)
    private val frames = ArrayDeque<Frame>()
    private var waitingSinceNs: Long? = null
    private var lastOfferedNs: Long? = null
    /**
     * When the last frame left the queue. Predictive frames age from here rather than from their
     * arrival: a keyframe can take hundreds of milliseconds on a slow link, and the frames that
     * waited behind it must not look stale the instant it lands.
     */
    private var lastPollNs = 0L
    var bytes = 0; private set
    val size get() = frames.size
    var needsKeyframe = true; private set
    var expired = 0L; private set
    var overflow = 0L; private set
    var skipped = 0L; private set

    fun offer(data: ByteArray, pts: Long, keyframe: Boolean, now: Long) = offer(HeapVideoFrame(data), pts, keyframe, now)
    fun offer(data: CompressedVideoFrame, pts: Long, keyframe: Boolean, now: Long, extraBytes: Int = 0): Boolean {
        // Count active recovery time, not a static screen's preceding idle period.
        if (waitingSinceNs != null && lastOfferedNs?.let { now - it >= 2_000_000_000L } == true) waitingSinceNs = now
        lastOfferedNs = now
        expire(now)
        val cost = data.size.toLong() + extraBytes
        if (cost > maxBytes || extraBytes < 0) { overflow++; invalidate(now); return false }
        if (frames.size >= maxFrames || cost > maxBytes - bytes) {
            overflow += frames.size
            invalidate(now)
        }
        if (needsKeyframe && !keyframe) { if (waitingSinceNs == null) waitingSinceNs = now; skipped++; return false }
        frames.addLast(Frame(data.retain(), pts, now, keyframe, cost.toInt())); bytes += cost.toInt(); needsKeyframe = false; waitingSinceNs = null
        return true
    }
    fun poll(now: Long): Frame? {
        expire(now)
        val frame = frames.removeFirstOrNull() ?: return null
        bytes -= frame.cost
        lastPollNs = now
        return frame
    }
    private fun expire(now: Long) {
        val head = frames.firstOrNull() ?: return
        if (now - maxOf(head.queuedAtNs, lastPollNs) >= maxAgeNs) {
            expired += frames.size
            invalidate(now)
        }
    }
    fun recoveryExpired(now: Long) = waitingSinceNs?.let { now - it >= recoveryGraceNs } == true
    fun invalidate(now: Long? = null) {
        frames.forEach { it.data.close() }; frames.clear(); bytes = 0; needsKeyframe = true
        if (waitingSinceNs == null) waitingSinceNs = now
    }
}
