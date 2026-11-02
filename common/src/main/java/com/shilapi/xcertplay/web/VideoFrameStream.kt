package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.media.CompressedVideoFrame
import java.io.Closeable

/**
 * One attached consumer of [WebVideoSource]'s compressed frames. The WebRTC direct stream and the
 * WebSocket codec stream implement it, so a head unit can switch transports without the source
 * knowing which one is live; only one consumer may be attached at a time.
 */
internal interface VideoFrameStream : Closeable {
    /** True while the transport can carry frames; gates [WebVideoSource.displayed]. */
    val connected: Boolean
    fun frame(frame: CompressedVideoFrame, pts: Long)
}
