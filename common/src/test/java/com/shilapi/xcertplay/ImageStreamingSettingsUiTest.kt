package com.shilapi.xcertplay

import androidx.compose.ui.test.*
import com.shilapi.xcertplay.web.*
import org.junit.Assert.*
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
class ImageStreamingSettingsUiTest : ComposeSettingsTest() {
    @Test fun userCanChooseFormatAndDragQualitySliderFromDisplaySettings() {
        val controller = Robolectric.buildActivity(DiPlayActivity::class.java).setup()
        val app = RuntimeEnvironment.getApplication()
        try {
            SettingsNavigation.open(controller.get(), "画面与串流", compose)
            clickTag("choice:IMAGE_FORMAT"); chooseOption(0)
            assertEquals(ImageFormat.JPEG, AirPlayPersistence.loadImageFormat(app))
            compose.onNodeWithTag("slider:image-quality:value").performScrollTo().assertTextEquals("75")
            setSlider("slider:image-quality", 6f)
            assertEquals(35, AirPlayPersistence.loadImageQuality(app))
            assertEquals(ImageEncodingOptions(ImageFormat.JPEG, 35), AirPlayPersistence.imageEncoding(app, ImageFormat.WEBP))
            compose.onNodeWithTag("slider:image-quality:value").performScrollTo().assertTextEquals("35")
            setSlider("slider:image-quality", 19f)
            assertEquals(100, AirPlayPersistence.loadImageQuality(app))
            setSlider("slider:image-quality", 17f)
            assertEquals(90, AirPlayPersistence.loadImageQuality(app))
            SettingsNavigation.open(controller.get(), "画面与串流", compose)
            compose.onNodeWithTag("slider:image-quality:value").performScrollTo().assertTextEquals("90")
            clickTag("choice:IMAGE_FORMAT"); chooseOption(1)
            assertEquals(ImageEncodingOptions(ImageFormat.WEBP, 90), AirPlayPersistence.imageEncoding(app, ImageFormat.WEBP))
            captureSettings(controller.get(), "image-streaming-settings")
        } finally { controller.pause().stop().destroy() }
    }
}
