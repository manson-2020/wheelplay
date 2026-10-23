package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.media.MediaCommand

/**
 * Media Session action names forwarded by the browser. The tested iPhone ignores the play/pause
 * toggle key (HID index 3) and the reported playback state stays PLAYING after a pause, so the
 * page alternates PAUSE / PLAY presses itself and every action maps to one concrete key. Seek
 * actions have no CarPlay equivalent and stay unmapped.
 */
internal object WebMediaKeys {
    fun command(action: String?): MediaCommand? = when (action) {
        "play" -> MediaCommand.PLAY
        "pause" -> MediaCommand.PAUSE
        "nexttrack" -> MediaCommand.NEXT
        "previoustrack" -> MediaCommand.PREVIOUS
        else -> null
    }
}
