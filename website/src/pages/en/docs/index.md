---
layout: ../../../layouts/DocsLayout.astro
title: User guide
description: Install, pair your browser, and choose CarPlay, experimental Android Auto, or VNC.
---

WheelPlay runs on an Android host and delivers display and control to your car browser over a local network. It supports CarPlay and experimental Android Auto and VNC sources. The car needs no client app; VNC requires an existing server on the remote device.

## What you need

- An Android device running **Android 9 or later** to host the service.
- Depending on your source: a CarPlay iPhone, an Android Auto phone, or a remote device running a VNC server. Diagnostic sources need no phone connection.
- A car browser with modern web and touch support that can reach the Android device.
- A local network that allows Android and your car to communicate.

Compatibility varies across vehicles, software versions, and networks. Complete the initial setup and testing while safely parked.

## Download and install

On your Android device, open [Download the latest build](/download?lang=en) to get `wheelplay-debug-apk` from GitHub. Extract the downloaded archive and install the APK inside.

The download entry selects the artifact from the latest successful `main` run of the `debug-build.yml` workflow. Results are cached for up to five minutes. GitHub may require you to sign in. If the artifact has expired or is missing from the latest build, try again later or check the [workflow runs](https://github.com/fython/wheelplay/actions/workflows/debug-build.yml).

To compile your own APK, see the [source build instructions](https://github.com/fython/wheelplay/blob/main/README.md#build).

## Choose an input source

Choose a connection from the app’s Input sources tab. Read [Sources & compatibility](/en/docs/sources/) to check device requirements and supported features.

- **CarPlay:** Connect an iPhone over USB or wirelessly; valid authentication assets are required.
- **Android Auto (experimental):** USB, same-phone, or Head Unit Server TCP. Manually start the server before a same-phone or TCP connection.
- **VNC (experimental):** Enter an existing server’s numeric IP address, port, and optional password. View-only mode is available.
- **Diagnostic sources:** Test the display pipeline without authentication assets. ICCOA is currently unavailable.

### CarPlay authentication assets

Public open-source builds do not include CarPlay authentication assets by default. In the Android app, open **Settings → CarPlay authentication assets** and import valid assets. Valid assets are required for CarPlay connections; the web service, browser pairing, and other sources work without them.

You can select `identity.pk8` and `certificate.p7b`, or import from a valid DiPlay APK. Import and validation happen locally on Android. Assets are stored in the app's private directory; they are neither uploaded nor included in backups.

See the [authentication import guide](https://github.com/fython/wheelplay/blob/main/docs/AUTHENTICATION_IMPORT.md) for detailed instructions. Some advanced repository guides are currently available in Chinese.

## Open your car browser

1. Install and open WheelPlay on Android; configure authentication assets only if you use CarPlay.
2. Connect Android and your car to the same local network.
3. In your car browser, open **the actual address displayed in the WheelPlay app**.

This website provides downloads and instructions. Use the local address in the app to connect your devices.

## Open the page and connect

1. Open the address shown in the app in the car browser. The page obtains credentials and connects on its own - no QR scan, pairing code, or "Start display" click.
2. Connection status and display options live behind the floating, draggable **circular status disc** (battery / network / volume): tap it to slide the drawer in from the right. The **Settings** button on the pairing page also works before connecting. The drawer holds Disconnect, an **Auto full screen** preference, a one-shot **Full screen / Exit full screen** button, video renderer, browser zoom, location and HTTPS options, using stored defaults before the connection starts.
3. Start a connection in the app using the [instructions for your source](/en/docs/sources/). For CarPlay, keep the app in the foreground during setup, complete device permissions, and allow CarPlay on the iPhone.
4. View and control the connected source in the car browser. VNC also supports a mouse and physical keyboard; view-only mode disables remote input.
5. Only one source runs at a time. If switching sources disconnects the browser, the page reconnects automatically.

Add `?manual=1` to restore the old QR/code launch page when troubleshooting. With **Auto full screen** on, each page load requests fullscreen and browsers that need a user gesture enter it on the first tap; audio / microphone permission also needs one tap.

Remembered browsers connect on every later visit. Clearing browser data, disabling storage, switching between HTTP and HTTPS, or changing the access address re-establishes trust automatically.

Under **Settings → Browser devices → Connected devices**, you can view, rename, or remove devices. Removing a device immediately disconnects it; the next visit re-establishes trust automatically. Only one browser control session is allowed at a time.

**Security note:** first-visit automatic trust means any browser on the same network that can open the address can view the picture and send touch input back to the phone. Use a trusted LAN or an isolated hotspot, and remove unfamiliar devices promptly.

## Audio and microphone

**CarPlay** uses Android audio and microphone by default, with optional browser routing under **Settings → Audio and microphone**. **Android Auto** uses host audio and microphone only, without browser routing. **VNC** has no audio support.

Browser microphone input requires a trusted local HTTPS certificate and the necessary browser capabilities. Pair again from the HTTPS address and grant permission. If your browser does not support this, continue using the Android microphone. See the [browser audio guide](https://github.com/fython/wheelplay/blob/main/docs/BROWSER_AUDIO.md) for configuration details.

## Connection troubleshooting

- Confirm that the service is running in the Android app. For CarPlay, also confirm that authentication assets passed validation.
- Start the Head Unit Server before same-phone / TCP Android Auto connections. For VNC, check the server address, port, and supported authentication method.
- Confirm that the car and Android can reach each other on the local network, and use the address shown in the app.
- If your browser restricts access to private network addresses, see the [experimental compatibility mode](/en/docs/tesla/).
- Read the [FAQ](/en/docs/faq/) for more on compatibility, permissions, and downloads.

Use trusted networks and do not expose the service to the public Internet. VNC should run over a trusted local network or VPN; HTTPS on the browser interface does not encrypt the VNC connection. Online navigation and music may still require Internet access.
