// SPDX-License-Identifier: AGPL-3.0-only
package moe.feng.wheelplay

import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** The remembered head-unit screen: preset -> last used -> pinned default -> deletion fallback. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29])
class CarPlayScreenMemoryTest {
    private val app get() = RuntimeEnvironment.getApplication()

    @Before
    fun reset() {
        CarPlayScreenMemory.clear(app)
    }

    @Test
    fun freshInstallStartsFromThe1184x920Preset() {
        assertTrue(CarPlayScreenMemory.list(app).isEmpty())
        val preset = CarPlayScreenMemory.default(app)
        assertEquals(1184, preset.width)
        assertEquals(920, preset.height)
        assertEquals(250, preset.widthPhysicalMm)
        assertTrue(preset.neverUsed)
        assertEquals("148:115", preset.aspectRatio)
        assertEquals(120, preset.dpi)
    }

    @Test
    fun theLastConnectedScreenBecomesTheNextLaunchDefault() {
        CarPlayScreenMemory.record(app, 1920, 1200, 250, now = 1_000L)
        CarPlayScreenMemory.record(app, 1184, 920, 250, now = 2_000L)
        val last = CarPlayScreenMemory.default(app)
        assertEquals("1184x920", last.key)
        assertEquals(2_000L, last.lastUsedAt)
        assertEquals(listOf("1184x920", "1920x1200"), CarPlayScreenMemory.list(app).map { it.key })
    }

    @Test
    fun aPinnedDefaultWinsUntilItIsRemoved() {
        CarPlayScreenMemory.record(app, 1920, 1200, 250, now = 1_000L)
        CarPlayScreenMemory.record(app, 1184, 920, 300, now = 2_000L)
        CarPlayScreenMemory.select(app, "1920x1200")
        assertEquals("1920x1200", CarPlayScreenMemory.defaultKey(app))
        CarPlayScreenMemory.remove(app, "1920x1200")
        assertEquals("1184x920", CarPlayScreenMemory.defaultKey(app))
    }

    @Test
    fun removingEveryScreenFallsBackToThePreset() {
        CarPlayScreenMemory.record(app, 1184, 920, 250, now = 1_000L)
        CarPlayScreenMemory.remove(app, "1184x920")
        assertTrue(CarPlayScreenMemory.list(app).isEmpty())
        assertEquals(CarPlayScreenMemory.preset().key, CarPlayScreenMemory.defaultKey(app))
    }

    @Test
    fun reconnectingTheSameResolutionRefreshesItsTimeAndDensity() {
        CarPlayScreenMemory.record(app, 1184, 920, 250, now = 1_000L)
        CarPlayScreenMemory.record(app, 1184, 920, 300, now = 2_000L)
        val entries = CarPlayScreenMemory.list(app)
        assertEquals(1, entries.size)
        assertEquals(2_000L, entries.single().lastUsedAt)
        assertEquals(300, entries.single().widthPhysicalMm)
        assertEquals(100, entries.single().dpi)
    }

    @Test
    fun historyIsCappedAndKeepsTheNewestScreens() {
        repeat(10) { index ->
            CarPlayScreenMemory.record(app, 1000 + index * 2, 800, 250, now = index.toLong() + 1)
        }
        val entries = CarPlayScreenMemory.list(app)
        assertEquals(3, entries.size)
        assertEquals("1018x800", entries.first().key)
        assertFalse(entries.any { it.key == "1000x800" })
    }

    @Test
    fun listenersFollowNegotiationsHappeningBehindTheSettingsScreen() {
        var changes = 0
        val listener = { changes += 1 }
        CarPlayScreenMemory.addChangeListener(listener)
        try {
            CarPlayScreenMemory.record(app, 1920, 1200, 250, now = 1_000L)
            CarPlayScreenMemory.select(app, "1920x1200")
            CarPlayScreenMemory.remove(app, "1920x1200")
            assertEquals(3, changes)
        } finally {
            CarPlayScreenMemory.removeChangeListener(listener)
        }
        CarPlayScreenMemory.record(app, 1184, 920, 250, now = 2_000L)
        assertEquals(3, changes)
    }

    @Test
    fun invalidSizesAreIgnored() {
        CarPlayScreenMemory.record(app, 0, 720, 250, now = 1_000L)
        CarPlayScreenMemory.record(app, 1280, -1, 250, now = 1_000L)
        assertTrue(CarPlayScreenMemory.list(app).isEmpty())
    }
}
