// SPDX-License-Identifier: AGPL-3.0-only
package moe.feng.wheelplay

import androidx.compose.ui.test.*
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], qualifiers = "zh-rCN-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HeadUnitScreenSettingsTest : ComposeSettingsTest() {
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun reset() {
        CarPlayScreenMemory.clear(app)
    }

    @Test
    fun aFreshInstallShowsThe1184x920PresetAsNeverUsed() {
        val controller = Robolectric.buildActivity(WheelPlayActivity::class.java).setup()
        try {
            SettingsNavigation.open(controller.get(), "画面与串流", compose)
            compose.onNodeWithTag("screen:1184x920").performScrollTo().assertExists()
            compose.onNodeWithText("预设尺寸 · 尚未连接").performScrollTo().assertExists()
            assertTrue(CarPlayScreenMemory.list(app).isEmpty())
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test
    fun tappingPinsADefaultAndTheDeleteButtonRemovesARecord() {
        CarPlayScreenMemory.record(app, 1920, 1200, 250, now = 1_000L)
        CarPlayScreenMemory.record(app, 1184, 920, 250, now = 2_000L)
        val controller = Robolectric.buildActivity(WheelPlayActivity::class.java).setup()
        try {
            SettingsNavigation.open(controller.get(), "画面与串流", compose)
            compose.onNodeWithTag("screen:1920x1200").performScrollTo().assertExists()
            compose.onNodeWithTag("screen:1184x920").performScrollTo().assertExists()
            captureSettings(controller.get(), "head-unit-screens")

            clickTag("screen:1920x1200")
            assertEquals("1920x1200", CarPlayScreenMemory.defaultKey(app))
            clickTag("screen-delete:1184x920")
            assertFalse(CarPlayScreenMemory.list(app).any { it.key == "1184x920" })
            compose.onNodeWithTag("screen:1184x920").assertDoesNotExist()
        } finally {
            controller.pause().stop().destroy()
        }
    }
}
