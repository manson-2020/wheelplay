// SPDX-License-Identifier: AGPL-3.0-only
package moe.feng.wheelplay

import android.content.Context
import com.shilapi.xcertplay.airplay.AirPlayDisplaySettings
import kotlin.math.roundToInt

/**
 * One head-unit canvas that has actually been negotiated with an iPhone. [widthPhysicalMm] is the
 * simulated screen width reported to iOS at the time, so the list can show the resulting density.
 * [lastUsedAt] is 0 only for the factory preset, which has never been used in a connection.
 */
data class RememberedCarPlayScreen(
    val key: String,
    val width: Int,
    val height: Int,
    val widthPhysicalMm: Int,
    val lastUsedAt: Long,
) {
    val neverUsed: Boolean
        get() = lastUsedAt <= 0L

    /** Reduced width:height, the way iOS lists car screens (e.g. 1920:1200 becomes 8:5). */
    val aspectRatio: String
        get() {
            var a = width
            var b = height
            while (b != 0) {
                val remainder = a % b
                a = b
                b = remainder
            }
            val divisor = a.coerceAtLeast(1)
            return "${width / divisor}:${height / divisor}"
        }

    /** Density implied by the physical width we reported for this canvas. */
    val dpi: Int
        get() = (width * 25.4 / widthPhysicalMm.coerceAtLeast(1)).roundToInt()
}

/**
 * Remembers the screen size of the last connected head unit, mirroring iOS's "CarPlay 画面 →
 * 车机屏幕" list.
 *
 * A fresh install negotiates the [preset] (1184 x 920 at the default 250 mm simulated width).
 * From then on the most recently used screen is the starting canvas of the next launch, so an
 * already-known head unit never needs a startup renegotiation; when the head unit reports its own
 * size the new canvas is recorded again. Tapping a row in settings pins that screen as the default
 * until the head unit reports a size; deleting a row falls back to the remaining history, and an
 * empty history falls back to the preset.
 */
object CarPlayScreenMemory {
    private const val PREFS = "carplay_screen_memory"
    private const val KEY_HISTORY = "screens"
    private const val KEY_DEFAULT = "default_screen"
    private const val LINE_SEPARATOR = '\n'
    private const val FIELD_SEPARATOR = '|'
    private const val MAX_ENTRIES = 3

    /** Change listeners let the settings screen follow negotiations that happen behind it. */
    private val listeners = java.util.concurrent.CopyOnWriteArraySet<() -> Unit>()

    fun addChangeListener(listener: () -> Unit) {
        listeners.add(listener)
    }

    fun removeChangeListener(listener: () -> Unit) {
        listeners.remove(listener)
    }

    private fun notifyChanged() {
        for (listener in listeners) listener()
    }

    /** Factory preset used for the very first connection (250 mm ⇒ 120 dpi, 148:115). */
    const val PRESET_WIDTH = 1184
    const val PRESET_HEIGHT = 920

    /** Tied to the "CarPlay 图标与文字大小" slider's shipped default (250 mm). */
    val PRESET_WIDTH_MM: Int
        get() = AirPlayDisplaySettings.DEFAULT_WIDTH_PHYSICAL_MM

    fun preset(): RememberedCarPlayScreen =
        RememberedCarPlayScreen(
            key = "${PRESET_WIDTH}x${PRESET_HEIGHT}",
            width = PRESET_WIDTH,
            height = PRESET_HEIGHT,
            widthPhysicalMm = PRESET_WIDTH_MM,
            lastUsedAt = 0L,
        )

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun encode(entries: List<RememberedCarPlayScreen>): String =
        entries.joinToString(LINE_SEPARATOR.toString()) { entry ->
            listOf(entry.key, entry.width, entry.height, entry.widthPhysicalMm, entry.lastUsedAt)
                .joinToString(FIELD_SEPARATOR.toString())
        }

    private fun decode(raw: String?): List<RememberedCarPlayScreen> {
        if (raw.isNullOrBlank()) return emptyList()
        return raw.split(LINE_SEPARATOR).mapNotNull { line ->
            val fields = line.split(FIELD_SEPARATOR)
            if (fields.size != 5) return@mapNotNull null
            val width = fields[1].toIntOrNull() ?: return@mapNotNull null
            val height = fields[2].toIntOrNull() ?: return@mapNotNull null
            val millimeters = fields[3].toIntOrNull() ?: return@mapNotNull null
            val lastUsedAt = fields[4].toLongOrNull() ?: return@mapNotNull null
            if (width <= 0 || height <= 0 || millimeters <= 0) return@mapNotNull null
            RememberedCarPlayScreen(fields[0], width, height, millimeters, lastUsedAt)
        }.sortedByDescending { it.lastUsedAt }
    }

    /** Most recently used first. Never contains the factory preset unless it was really used. */
    fun list(context: Context): List<RememberedCarPlayScreen> =
        decode(prefs(context).getString(KEY_HISTORY, null))

    /**
     * The canvas a new CarPlay session should start with: the pinned default, otherwise the last
     * connected screen, otherwise the factory preset.
     */
    fun default(context: Context): RememberedCarPlayScreen {
        val entries = list(context)
        val pinned = prefs(context).getString(KEY_DEFAULT, null)
        return entries.firstOrNull { it.key == pinned }
            ?: entries.firstOrNull()
            ?: preset()
    }

    fun defaultKey(context: Context): String = default(context).key

    /** Called once a session is actually negotiated, so only real connections enter the history. */
    @Synchronized
    fun record(
        context: Context,
        width: Int,
        height: Int,
        widthPhysicalMm: Int,
        now: Long = System.currentTimeMillis(),
    ) {
        if (width <= 0 || height <= 0) return
        val key = "${width}x${height}"
        val entries = list(context).toMutableList()
        val entry = RememberedCarPlayScreen(
            key = key,
            width = width,
            height = height,
            widthPhysicalMm = widthPhysicalMm.coerceAtLeast(1),
            lastUsedAt = now,
        )
        val index = entries.indexOfFirst { it.key == key }
        if (index >= 0) entries[index] = entry else entries.add(entry)
        val trimmed = entries.sortedByDescending { it.lastUsedAt }.take(MAX_ENTRIES)
        val editor = prefs(context).edit().putString(KEY_HISTORY, encode(trimmed))
        val pinned = prefs(context).getString(KEY_DEFAULT, null)
        if (pinned != null && trimmed.none { it.key == pinned }) editor.remove(KEY_DEFAULT)
        editor.apply()
        notifyChanged()
    }

    /** Pin a screen as the default until the head unit reports a size. */
    @Synchronized
    fun select(context: Context, key: String) {
        if (list(context).none { it.key == key }) return
        prefs(context).edit().putString(KEY_DEFAULT, key).apply()
        notifyChanged()
    }

    @Synchronized
    fun remove(context: Context, key: String) {
        val remaining = list(context).filterNot { it.key == key }
        val editor = prefs(context).edit().putString(KEY_HISTORY, encode(remaining))
        if (prefs(context).getString(KEY_DEFAULT, null) == key) editor.remove(KEY_DEFAULT)
        editor.apply()
        notifyChanged()
    }

    @Synchronized
    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
        notifyChanged()
    }
}
