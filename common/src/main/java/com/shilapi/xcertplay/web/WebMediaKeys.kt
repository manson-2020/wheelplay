package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.media.MediaCommand

/**
 * Media Session action names forwarded by the browser. The tested head unit only delivers play and
 * pause, but skip keys are mapped as well so a browser that does deliver them needs no further
 * change. Seek actions have no CarPlay equivalent and stay unmapped.
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
