package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.shared.R as UiR

/**
 * The three video channels, in the order the settings list offers them.
 *
 * - [WEBRTC] carries H.264 / HEVC over the native media transport. Lowest latency, but head units
 *   that treat a live media transport as a music source can take the phone's Bluetooth audio link
 *   - and the steering-wheel keys - away from it (docs/BROWSER_AUDIO.md).
 * - [WEBCODECS] carries the same access units over the paired WebSocket and decodes them with the
 *   browser's `VideoDecoder`: the negotiated frame rate without touching Bluetooth audio.
 * - [JPEG] streams still images and is the compatibility floor at roughly 15 fps.
 */
enum class StreamTechnology(@param:androidx.annotation.StringRes val labelRes: Int) {
    WEBRTC(UiR.string.ui_stream_webrtc),
    WEBCODECS(UiR.string.ui_stream_webcodecs),
    JPEG(UiR.string.ui_stream_images),
}
