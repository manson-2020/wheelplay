package com.shilapi.xcertplay.web

import com.shilapi.xcertplay.media.MediaCommand
import org.junit.Assert.*
import org.junit.Test

class WebMediaKeysTest {
    @Test fun mediaSessionActionsMapToCarPlayCommands() {
        assertEquals(MediaCommand.PLAY, WebMediaKeys.command("play"))
        assertEquals(MediaCommand.PAUSE, WebMediaKeys.command("pause"))
        assertEquals(MediaCommand.NEXT, WebMediaKeys.command("nexttrack"))
        assertEquals(MediaCommand.PREVIOUS, WebMediaKeys.command("previoustrack"))
    }

    @Test fun unmappedActionsNeverReachThePhone() {
        for (action in listOf("seekbackward", "seekforward", "toggle", "", null)) {
            assertNull(WebMediaKeys.command(action))
        }
    }
}
