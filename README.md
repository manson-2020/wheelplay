# WheelPlay

**English** · [简体中文](README.zh-CN.md)

Run CarPlay on an Android device and use it from your car's browser. WheelPlay hosts the display, touch controls, and pairing service on your local network; the car needs no additional app or server.

[Website](https://wheelplay.gwo.app/en/) · [Download development build](https://wheelplay.gwo.app/download?lang=en) · [User guide](https://wheelplay.gwo.app/en/docs/) · [FAQ](https://wheelplay.gwo.app/en/docs/faq/)

## What it supports

| Input source | Current support |
| --- | --- |
| **CarPlay** | USB and wireless iPhone connections, browser display and touch control. Requires valid CarPlay authentication resources. |
| **Android Auto — experimental** | USB AOA, explicit Head Unit Server TCP connections, and a guided same-phone connection. Device compatibility still needs validation. |
| **VNC — experimental** | Remote desktop over RFB 3.3/3.7/3.8, JPEG/WebP display, touch, mouse and physical keyboard input, and view-only mode. Actual server/device compatibility still needs validation. |
| **Android virtual desktop — experimental** | Shizuku UserService, local app selection, fixed-size JPEG/WebP output, multi-touch and Back. Requires Android 10+/Shizuku 13+; no physical-device compatibility validated yet. See the [guide](docs/ANDROID_DESKTOP.md). |
| **Diagnostic sources** | H.264, Surface, and framebuffer test sources for checking the display pipeline without a phone connection. |
| **Plugin APKs** | Install and enable independent Surface video/touch sources. Includes a standalone SDK and sample APK; see the [plugin guide](docs/PROJECTION_PLUGINS.md). |
| **ICCOA CarLink** | Planned as a separate plugin APK. No proprietary SDK or CarLink plugin is included. |

One projection source and one browser control session can be active at a time. For Android Auto, audio plays on the Android host and microphone input uses the host; browser audio/microphone routing and automatic wireless discovery are not implemented. See the [Android Auto guide](docs/ANDROID_AUTO.md) for setup and limitations.

## Features

- **Display and touch:** WebRTC H.264 / supported HEVC passthrough, JPEG / WebP compatibility streaming, fullscreen, and adjustable resolution, frame rate, and image quality. Native video is the default renderer; two experimental Canvas modes are also available.
- **Head-unit browser:** Opening the page connects automatically, with no QR scan or pairing code. The first visit is remembered; view, rename, or revoke browsers in settings. Display options live behind the floating circular status disc and slide in from the right.
- **CarPlay audio and controls:** Android audio and microphone by default, optional browser routing, and Media Session metadata and playback controls where the browser and phone app support them.
- **CarPlay preferences:** Day/night mode, safe margins, custom return-to-car name and icon, browser-disconnection behavior, and optional Android or browser GPS. The iPhone's own location is used by default.
- **Connection options:** Configurable HTTP / HTTPS listeners, certificate import, and opt-in Tesla compatibility through experimental no-root VPN or root hotspot routing.
- **Languages and diagnostics:** English, Simplified Chinese, and Traditional Chinese app/browser text follows Android's locale. Export diagnostic reports locally; the separate product website offers Chinese and English with light and dark themes.

## Getting started

### 1. Install WheelPlay

You need an **Android 9 or newer** host, a supported phone, and a modern car browser that can reach the host over the local network. Ordinary LAN operation does not require root.

[Download the latest development build](https://wheelplay.gwo.app/download?lang=en), then extract and install the APK from `wheelplay-debug-apk`. The link redirects to the artifact from the latest successful `main` run of [Android Debug Build](https://github.com/fython/wheelplay/actions/workflows/debug-build.yml); results are cached for up to five minutes. GitHub may require sign-in, and artifacts can expire. These are development builds, not stable releases.

### 2. Set up your input source

For **CarPlay**, open **Settings → CarPlay authentication resources**. Public CI builds do not bundle these resources. Import a matching `identity.pk8` and `certificate.p7b`, or import them from a compatible DiPlay APK using the app's guided flow. DiPlay itself does not need to be installed. Imports are validated locally and stored in private, backup-excluded storage; they are not uploaded. See the [authentication import guide](docs/AUTHENTICATION_IMPORT.md).

Missing CarPlay resources do not prevent the Web service, browser pairing, or diagnostic sources from working. For **Android Auto**, use **Input sources → Android Auto** and follow the [USB / local / TCP instructions](docs/ANDROID_AUTO.md). Same-phone mode requires manually starting Android Auto's Head Unit Server first.

For **VNC**, open **Input sources → VNC** and enter the IP address, port, and optional temporary password of an existing VNC server. Use a trusted LAN or VPN: VNC traffic is unencrypted and TLS/VeNCrypt is not supported. See the [VNC guide](docs/VNC.md) for setup and limitations.

### 3. Connect the car browser

1. Start WheelPlay and connect the Android host and car to a network where they can reach each other.
2. Open the **local address shown in the app** in the car browser. The product website is only for downloads and documentation. The page obtains credentials and connects on its own - no QR scan, pairing code, or "Start display" click.
3. For CarPlay, keep WheelPlay in the foreground during setup, connect the iPhone by USB or wirelessly, and complete Android permissions and the iPhone's CarPlay prompt. You can also start the connection from the browser's waiting screen.
4. Once connected, use the car touchscreen to control the projected interface.

There is no top bar: connection status and its actions live in the right-hand settings drawer. Tap the floating, draggable **circular status disc** (battery / network / volume) while connected, or the **Settings** button on the pairing page before connecting. The drawer also holds Disconnect (available while connected), an **Auto full screen** preference, a one-shot **Full screen / Exit full screen** button, video renderer, browser zoom, location and HTTPS options; stored defaults are applied before the connection starts.

Later visits restore the remembered browser and connect immediately. Clearing browser storage, changing the address, or switching HTTP / HTTPS re-establishes trust automatically. Remove remembered devices under **Settings → Browser devices → Connected devices**.

The page connects automatically by default. Query parameters: `?code=123456` connects with that code; `?auto=1` is now equivalent to the default (kept for compatibility); `?manual=1` restores the QR/code launch page for troubleshooting; `?diag=1` / `?unhide=1` show WebRTC and still-image diagnostics or keep the pre-first-frame video in the layout. Combine them with `&`, for example `?auto=1&diag=1`. `?ms=1` lets the page own the head-unit media session: it registers `navigator.mediaSession` and forwards play, pause and skip actions to the phone, which sends them to the iPhone; the `?diag=1` panel shows `ms=… key=… last=<action> media=<action>→<result>` (measured: some head units only deliver play/pause, because skip keys are AVRCP commands sent only while Bluetooth audio is connected); `?ms=2` additionally plays browser audio through a media element, because Chrome only routes platform media keys to the page owning a playing media element. With **Auto full screen** on, each page load requests fullscreen; browsers that need a user gesture enter it on the first tap. Audio / microphone permission also needs one tap inside the page.

Manage remembered browsers under Settings → 浏览器设备 (Browser devices) → 连接过的设备 (Connected devices). View names, pairing times, last connection times and addresses; rename or remove one browser, or remove all. Removal immediately disconnects the device and revokes its existing sessions; the next visit re-establishes trust automatically. Browser disconnection and server restarts retain device memory. Up to 32 browsers can be saved; remove an old entry if the limit is reached.

## Compatibility notes

- Browser microphone and GPS access require trusted HTTPS and browser permissions. Android handles CarPlay audio/microphone by default; browser GPS is off on each page load. See [audio and HTTPS setup](docs/BROWSER_AUDIO.md).
- Actual frame rate and stability depend on the phone, host, browser, network, and Android background restrictions. WebRTC uses local UDP without external STUN/TURN and falls back to image streaming when necessary. Canvas rendering does not guarantee higher frame rates or bypass car browser restrictions.
- Browsers that block private IP addresses may need [Tesla compatibility mode](docs/TESLA_HTTP.md). Its availability does not establish compatibility with every car or Android device.
- Use a trusted local network. HTTP traffic is unencrypted; optional HTTPS requires a trusted certificate. Do not expose the service to the public internet. Complete setup and compatibility testing while parked.
- First-visit automatic trust means any browser on that network that can open the address can view the picture and send touch input back to the phone. Use an isolated hotspot or trusted LAN, and revoke unfamiliar devices under **Settings → Browser devices → Connected devices**. `/stream` still requires a token and the same-origin check.

## Build

### Android app

The current build uses the following toolchain. The Gradle wrapper and daemon JVM configuration are committed to the repository.

| Tool | Version |
| --- | --- |
| JDK | 25 |
| Gradle / Android Gradle Plugin | 9.3.1 / 9.1.0 |
| Android SDK / Build Tools | API 36 / 36.0.0 |
| Android NDK / CMake | 28.2.13676358 / 3.22.1 |
| Node.js for browser tests and fixtures | 22 or newer |

Configure your Android SDK through `ANDROID_HOME` or `sdk.dir` in an untracked `local.properties`, install the toolchain above, then run from the repository root:

```sh
./gradlew :mobile:assembleDebug
```

Output: `mobile/build/outputs/apk/debug/mobile-debug.apk` (application ID `top.wheelpay.tesla.debug`). The first native build fetches pinned libdatachannel and Mbed TLS sources from GitHub. The default build excludes CarPlay authentication resources; import them after installation.

For a private provisioned build, place `offline-mfi/identity.pk8` and `offline-mfi/certificate.p7b` beneath `.local/auth-assets/` or the directory selected by `WHEELPLAY_AUTH_ASSETS_DIR`, then run `./gradlew :mobile:assembleProvisionedDebug` to verify the packaged files. Keep these resources out of Git and public APKs.

You can also bundle an HTTPS certificate: put an `https_cert.zip` containing `fullchain.pem` and `privkey.pem` under `.local/`, and the build packages it as an APK asset. When present, HTTPS under **Network & access** uses the bundled certificate by default (a custom upload still overrides it); without the file the default local certificate applies. Do not commit or distribute this archive either.

Run the Android checks used by CI:

```sh
./gradlew :shared:testDebugUnitTest :common:testDebugUnitTest \
  :common:assembleDebugAndroidTest :mobile:lintDebug :mobile:assembleDebug
```

The instrumented test APK is built by this command; CI separately runs browser-page tests on Android 9 and Android 16 emulators. For browser-side checks and the desktop demo:

```sh
npm ci
npm test
npm run check
npm run demo
```

The demo runs at `http://localhost:8081` and connects on open (`?manual=1` still accepts pairing code `123456`), with synthetic video. It is a development fixture; the actual phone connection and LAN server run in the Android app.

### Product website

The Astro website in [`website/`](website/README.md) has independent dependencies. Use Node.js 24 LTS; no Android SDK is needed.

```sh
npm ci --prefix website
npm run site:dev
```

To validate and build:

```sh
npm run site:check
npm run site:build
npm run site:test
```

The static output is `website/dist/`. Chinese and English documentation lives in Markdown. Cloudflare Workers or Pages Functions handle `/download` through a shared cached GitHub artifact resolver; Astro's development server does not run that endpoint. See the [website guide](website/README.md) for deployment configuration.

## Repository and documentation

| Path | Contents |
| --- | --- |
| [`mobile/`](mobile/) | Android application entry point and packaging |
| [`common/`](common/) | Host UI, Compose settings, LAN server, browser assets, projection sources, and native WebRTC bridge |
| [`shared/`](shared/) | CarPlay / AirPlay, Android Auto, and VNC protocol components and shared resources |
| [`website/`](website/) | Astro product website and Cloudflare download endpoint |
| [`scripts/`](scripts/), [`test/`](test/) | Desktop fixtures and browser / repository checks |
| [`docs/`](docs/README.md) | Implementation guides, validation notes, and retained upstream documentation |

For deeper troubleshooting, see [projection sources](docs/PROJECTION_IMPLEMENTATION.md), [WebRTC recovery](docs/WEBRTC_RECOVERY.md), [image streaming](docs/IMAGE_STREAM.md), [rendering modes](docs/MEDIA_PRESENTATION.md), and [media controls](docs/MEDIA_SESSION.md). Most implementation guides are in Chinese. Browser diagnostics are exposed through `window.wheelplayStats`; their per-stage metrics do not measure end-to-end latency.

## Origins and licensing

WheelPlay is based on **DiPlay / xcertplay** and retains the upstream licenses and notices. See [LICENSE](LICENSE), the [upstream notes](docs/UPSTREAM.md), and [third-party notices](docs/upstream/THIRD_PARTY_NOTICES.md); third-party components and assets remain subject to their respective terms. Native WebRTC dependencies have [separate license notices](common/src/main/assets/webrtc-licenses.txt), also distributed in the APK.
