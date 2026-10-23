package com.shilapi.xcertplay.web

import android.content.Context
import android.os.SystemClock
import android.util.Log
import com.shilapi.xcertplay.CarPlayBackgroundSession
import com.shilapi.xcertplay.airplay.AirPlayContact
import com.shilapi.xcertplay.airplay.VideoCodec
import com.shilapi.xcertplay.shared.R as UiR
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoWSD
import java.io.IOException
import java.io.InputStream
import java.net.Socket
import java.net.URI
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/** Same-origin HTTP assets and a single paired, backpressured video/control WebSocket. */
internal class LanWebServer(
    private val context: Context,
    private val code: String,
    port: Int = WebListenSettings.DEFAULT_HTTP_PORT,
    private val secure: Boolean = false,
    val pairing: QrPairing = QrPairing(),
) : NanoWSD("0.0.0.0", port) {
    init {
        require(port == 0 || port in 1024..65535) {
            context.getString(UiR.string.ui_use_high_ports_for_web_listeners_low_ports_are)
        }
    }

    val ready
        get() = isAlive

    @Volatile private var viewer: Client? = null
    private val timer = Executors.newSingleThreadScheduledExecutor()
    @Volatile private var failures = 0
    @Volatile private var retryAt = 0L
    private val devices = WebSession.rememberedBrowsers(context)
    private val enrolled = mutableMapOf<String, RememberedBrowsers.Credential>()
    val hasViewer
        get() = viewer != null
    val imageFormat
        get() = viewer?.imageFormat ?: ImageFormat.JPEG

    fun frameAvailable() {
        viewer?.frameAvailable()
    }

    fun disconnectViewer() {
        viewer?.disconnect(context.getString(UiR.string.ui_device_removed))
    }

    fun disconnectUnauthorized() {
        viewer?.let {
            if (!it.authorized())
                it.disconnect(context.getString(UiR.string.ui_device_removed_or_pairing_expired))
        }
    }

    @Synchronized
    private fun acceptCode(value: String?): Boolean {
        val now = SystemClock.elapsedRealtime()
        if (now < retryAt) return false
        if (value != code) {
            if (++failures >= 5) {
                retryAt = now + 30000
                failures = 0
            }
            return false
        }
        failures = 0
        return true
    }

    init {
        timer.scheduleAtFixedRate(
            {
                val now = SystemClock.elapsedRealtime()
                WebSession.touch.expire(now)
                disconnectUnauthorized()
                viewer?.let {
                    if (now - it.lastSeen > 6000 || it.frameStalled(now))
                        it.disconnect(context.getString(UiR.string.ui_connection_timed_out))
                }
            },
            500,
            500,
            TimeUnit.MILLISECONDS,
        )
    }

    override fun serve(session: IHTTPSession): Response {
        if (session.uri == "/stream" && isWebsocketRequested(session)) {
            val origin = session.headers["origin"]
            val sameOrigin =
                runCatching {
                        val parsed = URI(origin ?: "")
                        parsed.scheme == (if (secure) "https" else "http") &&
                            parsed.rawAuthority.equals(session.headers["host"], true)
                    }
                    .getOrDefault(false)
            if (!sameOrigin) return response(Response.Status.FORBIDDEN, "Origin rejected")
            if (
                !pairing.authorized(session.parameters["token"]?.firstOrNull()) &&
                    !acceptCode(session.parameters["code"]?.firstOrNull())
            ) {
                return response(Response.Status.UNAUTHORIZED, "Pairing code required")
            }
            return super.serve(session)
        }
        // Never upgrade arbitrary paths into a control channel.
        if (isWebsocketRequested(session)) return response(Response.Status.NOT_FOUND, "Not found")
        return serveHttp(session)
    }

    override fun serveHttp(session: IHTTPSession): Response {
        if (session.uri.startsWith("/pair/")) return servePairing(session)
        if (session.method != Method.GET)
            return response(Response.Status.METHOD_NOT_ALLOWED, "GET only")
        if (session.uri == "/i18n.js")
            return newFixedLengthResponse(
                    Response.Status.OK,
                    "text/javascript; charset=utf-8",
                    BrowserStrings.script(context),
                )
                .apply {
                    addHeader("Cache-Control", "no-store")
                    addHeader("X-Content-Type-Options", "nosniff")
                }
        if (session.uri == "/tls.json")
            return newFixedLengthResponse(
                    Response.Status.OK,
                    "application/json",
                    JSONObject()
                        .put("available", WebSession.httpsReady)
                        .put("fingerprint", WebSession.tls?.fingerprint)
                        .put("port", WebSession.httpsPortFor(context, session.headers["host"]))
                        .put("customCertificate", WebSession.tls?.custom == true)
                        .put("enabled", WebListenSettings.httpsEnabled(context))
                        .put("error", WebSession.tlsError)
                        .toString(),
                )
                .apply { addHeader("Cache-Control", "no-store") }
        if (session.uri == "/certificate.crt") {
            val bytes =
                WebSession.tls?.certificate
                    ?: return response(Response.Status.NOT_FOUND, "HTTPS not ready")
            return newFixedLengthResponse(
                    Response.Status.OK,
                    "application/x-x509-ca-cert",
                    bytes.inputStream(),
                    bytes.size.toLong(),
                )
                .apply {
                    addHeader(
                        "Content-Disposition",
                        "attachment; filename=wheelplay-certificate.crt",
                    )
                    addHeader("Cache-Control", "no-store")
                }
        }
        val asset =
            when (session.uri) {
                "/",
                "/index.html" -> "index.html" to "text/html; charset=utf-8"
                "/text.js" -> "text.js" to "text/javascript; charset=utf-8"
                "/app.js" -> "app.js" to "text/javascript; charset=utf-8"
                "/style.css" -> "style.css" to "text/css; charset=utf-8"
                "/browser-audio.js" -> "browser-audio.js" to "text/javascript; charset=utf-8"
                "/audio-worklet.js" -> "audio-worklet.js" to "text/javascript; charset=utf-8"
                else -> return response(Response.Status.NOT_FOUND, "Not found")
            }
        return context.assets.open("web/${asset.first}").use {
            val bytes =
                if (asset.first == "index.html")
                    BrowserStrings.render(context, it.bufferedReader().readText())
                        .toByteArray(Charsets.UTF_8)
                else it.readBytes()
            newFixedLengthResponse(
                    Response.Status.OK,
                    asset.second,
                    bytes.inputStream(),
                    bytes.size.toLong(),
                )
                .apply {
                    addHeader("Cache-Control", "no-store")
                    addHeader("X-Content-Type-Options", "nosniff")
                    addHeader("Referrer-Policy", "no-referrer")
                    addHeader(
                        "Content-Security-Policy",
                        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
                    )
                }
        }
    }

    private fun servePairing(session: IHTTPSession): Response {
        val id = session.headers["x-pair-id"] ?: session.parameters["id"]?.firstOrNull()
        val secret = session.headers["x-pair-secret"] ?: session.parameters["secret"]?.firstOrNull()
        if (session.uri == "/pair/qr" && session.method == Method.GET) {
            val request =
                pairing.get(id, secret) ?: return response(Response.Status.NOT_FOUND, "Expired")
            val matrix =
                com.google.zxing.qrcode
                    .QRCodeWriter()
                    .encode(
                        request.payload,
                        com.google.zxing.BarcodeFormat.QR_CODE,
                        0,
                        0,
                        mapOf(com.google.zxing.EncodeHintType.MARGIN to 4),
                    )
            val path = buildString {
                for (y in 0 until matrix.height) for (x in 0 until matrix.width) {
                    if (matrix[x, y]) append("M$x,$y h1v1h-1z")
                }
            }
            val svg =
                """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${matrix.width} ${matrix.height}" shape-rendering="crispEdges"><path fill="white" d="M0,0h${matrix.width}v${matrix.height}H0z"/><path fill="black" d="$path"/></svg>"""
            return newFixedLengthResponse(Response.Status.OK, "image/svg+xml", svg).apply {
                addHeader("Cache-Control", "no-store")
                addHeader("X-Content-Type-Options", "nosniff")
                addHeader("Referrer-Policy", "no-referrer")
            }
        }
        if (session.method != Method.POST)
            return response(Response.Status.METHOD_NOT_ALLOWED, "POST only")
        val sameOrigin =
            runCatching {
                    val origin = URI(session.headers["origin"] ?: "")
                    origin.scheme == (if (secure) "https" else "http") &&
                        origin.rawAuthority.equals(session.headers["host"], true)
                }
                .getOrDefault(false)
        if (!sameOrigin) return response(Response.Status.FORBIDDEN, "Origin rejected")
        val json =
            when (session.uri) {
                "/pair/request" -> {
                    val request =
                        pairing.create(session.remoteIpAddress)
                            ?: return response(
                                Response.Status.FORBIDDEN,
                                "Too many requests; try again in two minutes",
                            )
                    JSONObject()
                        .put("id", request.id)
                        .put("secret", request.pollSecret)
                        .put("expiresIn", 120)
                }
                "/pair/status" -> {
                    val request =
                        pairing.get(id, secret)
                            ?: return response(Response.Status.NOT_FOUND, "Expired")
                    JSONObject()
                        .put("state", if (request.token == null) "pending" else "approved")
                        .apply { request.token?.let { put("token", it) } }
                }
                "/pair/code" -> {
                    if (!acceptCode(session.headers["x-pair-code"]))
                        return response(Response.Status.UNAUTHORIZED, "Pairing code required")
                    val token =
                        pairing.issueToken()
                            ?: return response(Response.Status.FORBIDDEN, "Too many sessions")
                    JSONObject().put("token", token)
                }
                "/pair/remember" ->
                    synchronized(devices) {
                        val token = session.headers["x-pair-token"]
                        if (token == null || !pairing.authorized(token))
                            return response(Response.Status.UNAUTHORIZED, "Pairing required")
                        enrolled.entries.removeAll { !pairing.authorized(it.key) }
                        val credential =
                            enrolled[token]
                                ?: run {
                                        // Resumed tokens are already bound. They cannot create
                                        // additional devices.
                                        if (pairing.deviceId(token) != null)
                                            return response(
                                                Response.Status.FORBIDDEN,
                                                "Device already remembered",
                                            )
                                        val name =
                                            browserName(session.headers["user-agent"].orEmpty())
                                        devices.remember(name, session.remoteIpAddress)
                                            ?: return response(
                                                Response.Status.FORBIDDEN,
                                                "Cannot remember device; check device limit",
                                            )
                                    }
                                    .also { enrolled[token] = it }
                        pairing.bindDevice(token, credential.device.id)
                        JSONObject()
                            .put("id", credential.device.id)
                            .put("secret", credential.secret)
                            .put("name", credential.device.name)
                    }
                "/pair/resume" ->
                    synchronized(devices) {
                        val device =
                            devices.authenticate(
                                session.headers["x-device-id"],
                                session.headers["x-device-secret"],
                                session.remoteIpAddress,
                            )
                                ?: return response(
                                    Response.Status.UNAUTHORIZED,
                                    "Device not remembered",
                                )
                        val token =
                            pairing.issueToken(device.id)
                                ?: return response(Response.Status.FORBIDDEN, "Too many sessions")
                        JSONObject().put("token", token).put("name", device.name)
                    }
                "/pair/revoke" -> {
                    pairing.revoke(session.headers["x-pair-token"])
                    JSONObject().put("state", "revoked")
                }
                "/pair/cancel" -> {
                    pairing.cancel(id, secret)
                    JSONObject().put("state", "cancelled")
                }
                else -> return response(Response.Status.NOT_FOUND, "Not found")
            }
        return newFixedLengthResponse(Response.Status.OK, "application/json", json.toString())
            .apply {
                addHeader("Cache-Control", "no-store")
                addHeader("X-Content-Type-Options", "nosniff")
            }
    }

    private fun browserName(agent: String): String {
        val browser =
            when {
                "Edg/" in agent -> "Edge"
                "Chrome/" in agent -> "Chrome"
                "Firefox/" in agent -> "Firefox"
                "Safari/" in agent -> "Safari"
                else -> context.getString(UiR.string.ui_browser)
            }
        val platform =
            when {
                "Android" in agent -> "Android"
                "iPhone" in agent || "iPad" in agent -> "iOS"
                "Windows" in agent -> "Windows"
                "Macintosh" in agent -> "macOS"
                "Linux" in agent -> "Linux"
                else -> null
            }
        return if (platform == null) browser else "$browser · $platform"
    }

    private fun response(status: Response.Status, text: String) =
        newFixedLengthResponse(status, NanoHTTPD.MIME_PLAINTEXT, text).apply {
            addHeader("Cache-Control", "no-store")
        }

    override fun openWebSocket(handshake: IHTTPSession): WebSocket = Client(handshake)

    /**
     * NanoHTTPD never exposes the accepted socket, but ICE must answer from the address this
     * client actually reached. The handler thread is also the thread that serves the handshake.
     */
    private val connectionAddress = ThreadLocal<String?>()

    override fun createClientHandler(clientSocket: Socket, input: InputStream?): ClientHandler =
        object : ClientHandler(input, clientSocket) {
            override fun run() {
                connectionAddress.set(runCatching { clientSocket.localAddress?.hostAddress }.getOrNull())
                try { super.run() } finally { connectionAddress.remove() }
            }
        }

    override fun stop() = stopListener(clearPairing = true)

    fun stopPreservingPairing() = stopListener(clearPairing = false)

    private fun stopListener(clearPairing: Boolean) {
        viewer?.disconnect(context.getString(UiR.string.ui_service_stopped))
        if (!secure && clearPairing) pairing.clear()
        timer.shutdownNow()
        super.stop()
    }

    private inner class Client(handshake: IHTTPSession) : WebSocket(handshake) {
        private val token = handshake.parameters["token"]?.firstOrNull()?.takeIf { it.isNotEmpty() }
        private val mediaVersion = handshake.parameters["media"]?.firstOrNull()?.toIntOrNull()?.takeIf { it in 2..3 } ?: 1
        private val imageProtocol = if (mediaVersion == 2 && handshake.parameters["images"]?.firstOrNull() == "3") 3 else mediaVersion
        private val versionedMedia = imageProtocol >= 2
        @Volatile var imageFormat = ImageFormat.JPEG
            private set
        private var imageFallback = false
        // The address this browser reached us on; ICE must answer from it. VPN aliases such as
        // the Tesla compatibility address are local but not on the hotspot interface.
        private val rtcBindAddress = RtcBindAddress.forAddress(connectionAddress.get()).also {
            Log.i("WheelPlayWeb", "rtc-bind local=${connectionAddress.get() ?: "none"} bound=${it ?: "any"}")
        }

        fun authorized() = token == null || pairing.authorized(token)

        @Volatile var lastSeen = SystemClock.elapsedRealtime()

        fun frameStalled(now: Long) = sender.frameStalled(now)

        fun frameAvailable() = sender.frameAvailable()

        private val ended = AtomicBoolean(false)
        private val closing = AtomicBoolean(false)
        private val sender =
            WebStreamSender(
                latestFrame = {
                    if (
                        viewer === this &&
                            !closing.get() &&
                            WebSession.videoSource?.jpegNeeded != false
                    )
                        WebSession.frame?.takeIf { it.format == ImageFormat.JPEG ||
                            imageProtocol == 3 && imageFormat == ImageFormat.WEBP &&
                                com.shilapi.xcertplay.AirPlayPersistence.loadImageFormat(context) == ImageFormat.WEBP }
                    else null
                },
                write = { super.sendFrame(it) },
                onFailure = {
                    disconnect(context.getString(UiR.string.ui_streaming_connection_interrupted))
                },
                versionedVideo = versionedMedia,
                imageProtocol = imageProtocol,
            )
        private val rtcLock = Any()
        private var rtcSource: WebVideoSource? = null
        private var rtcConfig: WebVideoSource.Config? = null
        private var rtc: RtcVideoStream? = null
        private val rtcRetry = RtcRetryPolicy()
        private var rtcId = 0L
        private var rtcAnswered = false
        // Stage-tagged WebRTC evidence: head units have no reachable console, so the phone keeps
        // what it can see from its own offer and from the browser's answer and fallback reason.
        private var rtcAnswer: RtcSdpSummary.Summary? = null
        private var rtcOffer: RtcSdpSummary.Summary? = null
        private var rtcDiagnostics: String? = null
        private var rtcFallbackStates: String? = null
        // Kept across retries and cleared only by a displayed frame: a head unit photo taken
        // between attempts must still show why the previous attempt stopped.
        private var rtcLastFallback: String? = null
        // Last forwarded Media Session action and its CarPlay result, echoed back to ?diag=1.
        private var mediaEcho: String? = null
        private var rtcHint: String? = null
        private var hevcSupported = true
        private var rtcAvailableSince = 0L
        private var rtcNotRequested = false
        // Head-unit telemetry placeholder: last live-transition count reported by the browser.
        private var lastLiveTransitions = -1

        private fun reconcileVideo() =
            synchronized(rtcLock) {
                val source = WebSession.videoSource
                if (rtcSource !== source || rtcConfig !== source?.config) {
                    // A genuine iPhone video reconfiguration (new codec parameters) re-arms one
                    // WebRTC attempt. Log it so the head-unit retry cadence is visible from the
                    // Android host logcat without a browser console; a repeated cadence here is the
                    // "flicker every so often" the Tesla browser reports.
                    if (rtcRetry.attempted) {
                        Log.i(
                            "WheelPlayWeb",
                            "rtc-attempt re-armed t=${SystemClock.elapsedRealtime()} " +
                                "sourceChanged=${rtcSource !== source} configChanged=${rtcConfig !== source?.config}",
                        )
                    }
                    stopRtc()
                    rtcSource = source
                    rtcConfig = source?.config
                    rtcRetry.reset()
                }
            }

        private fun stopRtc(retryable: Boolean = true) =
            synchronized(rtcLock) {
                val old = rtc
                rtc = null
                rtcRetry.finish(retryable)
                if (old != null) {
                    rtcSource?.detach(old)
                    old.close()
                    reply(
                        WebStreamSender.Control.RTC,
                        JSONObject().put("type", "rtc-stop").put("id", rtcId).toString(),
                    )
                }
                sender.frameAvailable()
            }

        private fun startRtc() {
            // Service stop holds WebSession before closing clients. Never acquire that monitor
            // while holding rtcLock; carry a coherent snapshot and validate its source identity.
            val media = WebSession.mediaSnapshot()
            synchronized(rtcLock) {
                reconcileVideo()
                if (rtc != null || !rtcRetry.available || ended.get() || !WebSession.videoActive) return
                val source = rtcSource ?: return
                val config = rtcConfig ?: return
                if (media.source !== source || media.sourceState == "stopped") return
                if (config.codec == VideoCodec.H265 && !hevcSupported) {
                    // The browser already reported that it cannot decode HEVC; the iPhone, not the
                    // service, chooses the codec, so keep JPEG and ask for the setting to change.
                    rtcHint = "hevc-unsupported"
                    // Block retries so `rtcAvailable` turns false: otherwise the head unit keeps
                    // offering and the 15 s watchdog would overwrite this hint.
                    rtcRetry.block()
                    return
                }
                if (!rtcRetry.start()) return
                rtcHint = null
                rtcAnswered = false
                rtcAnswer = null
                rtcOffer = null
                rtcDiagnostics = null
                rtcFallbackStates = null
                rtcAvailableSince = 0L
                rtcNotRequested = false
                val id = ++rtcId
                Log.i(
                    "WheelPlayWeb",
                    "rtc-attempt start id=$id codec=${config.codec.name} t=${SystemClock.elapsedRealtime()}",
                )
                val recovery =
                    com.shilapi.xcertplay.AirPlayPersistence.loadRtcRecoveryPolicy(context)
                val stream =
                    RtcVideoStream(
                        source,
                        config,
                        recovery,
                        rtcBindAddress,
                        offer = { sdp ->
                            val summary = RtcSdpSummary.summarize(sdp)
                            Log.i(
                                "WheelPlayWeb",
                                "rtc-offer id=$id codec=${config.codec.name} " +
                                    "bind=${rtcBindAddress ?: "any"} " +
                                    "profile=${summary.profileLevelId ?: "none"} ${summary.describe()}",
                            )
                            synchronized(rtcLock) {
                                rtcOffer = summary
                                if (!ended.get() && rtc != null && rtcId == id)
                                    reply(
                                        WebStreamSender.Control.RTC,
                                        JSONObject()
                                            .put("type", "rtc-offer")
                                            .put("id", id)
                                            .put("sessionId", media.sessionId)
                                            .put("videoEpoch", media.videoEpoch)
                                            .put("codec", config.codec.name)
                                            .put("recoveryGraceMs", recovery.graceMs)
                                            .put("sdp", sdp)
                                            .toString(),
                                    )
                            }
                        },
                        failure = { retryable -> synchronized(rtcLock) { if (rtcId == id) stopRtc(retryable) } },
                    )
                rtc = stream
                if (!source.attach(stream, config)) {
                    stopRtc()
                    return
                }
                stream.start()
            }
        }

        private fun reply(
            kind: WebStreamSender.Control,
            text: String,
            key: Any = kind,
            afterSend: () -> Unit = {},
        ) {
            sender.control(
                kind,
                WebSocketFrame(WebSocketFrame.OpCode.Text, true, text),
                key,
                afterSend,
            )
        }

        // NanoWSD also replies to RFC6455 Ping/Close on its reader thread. Route those writes too.
        override fun sendFrame(frame: WebSocketFrame) {
            when (frame.opCode) {
                WebSocketFrame.OpCode.Pong -> sender.control(WebStreamSender.Control.PONG, frame)
                WebSocketFrame.OpCode.Close ->
                    sender.control(WebStreamSender.Control.CLOSE, frame) {
                        disconnect(context.getString(UiR.string.ui_connection_closed))
                    }
                else -> error("Application frames must use the stream sender")
            }
        }

        override fun close(
            code: WebSocketFrame.CloseCode?,
            reason: String?,
            initiatedByRemote: Boolean,
        ) {
            // Keep the reader alive until the queued close reply is written; NanoWSD's default
            // close changes state immediately and would close the socket before this async write.
            // A close frame without a status code reaches here as null code/reason, and NanoWSD's
            // CloseFrame answers it with an equally payload-free close frame.
            if (closing.compareAndSet(false, true))
                sendFrame(WebSocketFrame.CloseFrame(code, reason))
        }

        override fun onOpen() {
            if (!authorized()) {
                disconnect(context.getString(UiR.string.ui_pairing_expired))
                return
            }
            synchronized(this@LanWebServer) {
                if (viewer != null || !WebSession.touch.claim(this)) {
                    reply(
                        WebStreamSender.Control.BUSY,
                        JSONObject()
                            .put("type", "busy")
                            .put(
                                "message",
                                context.getString(UiR.string.ui_another_head_unit_is_connected),
                            )
                            .toString(),
                    ) {
                        disconnect(context.getString(UiR.string.ui_another_head_unit_is_connected))
                    }
                    return
                }
                viewer = this
                WebSession.viewerStateChanged()
                WebSession.audio.attach(
                    this,
                    secure,
                    { packet, sequence -> sender.audio(packet, sequence) },
                    { text ->
                        val data = JSONObject(text)
                        val kind =
                            when (data.getString("type")) {
                                "mic-config" -> WebStreamSender.Control.MIC_CONFIG
                                "mic-stop" -> WebStreamSender.Control.MIC_STOP
                                "audio-route" -> {
                                    sender.configureAudioBuffer(data.getInt("mediaBufferMillis"))
                                    if (!data.getBoolean("playback")) sender.clearAudio()
                                    WebStreamSender.Control.AUDIO_ROUTE
                                }
                                "audio-stop" -> {
                                    sender.clearAudioStream(data.getInt("stream"))
                                    WebStreamSender.Control.AUDIO_STOP
                                }
                                else -> {
                                    sender.clearAudio()
                                    WebStreamSender.Control.AUDIO_RESET
                                }
                            }
                        reply(
                            kind,
                            text,
                            if (kind == WebStreamSender.Control.AUDIO_STOP)
                                kind to data.getInt("stream")
                            else kind,
                        )
                    },
                )
            }
            sender.frameAvailable()
        }

        override fun onMessage(message: WebSocketFrame) {
            if (ended.get() || closing.get() || viewer !== this) return
            if (!authorized()) {
                disconnect(context.getString(UiR.string.ui_device_removed_or_pairing_expired))
                return
            }
            try {
                if (message.opCode == WebSocketFrame.OpCode.Binary) {
                    require(message.binaryPayload.size <= 20_000)
                    lastSeen = SystemClock.elapsedRealtime()
                    WebSession.audio.input(this, message.binaryPayload)
                    return
                }
                require(
                    message.opCode == WebSocketFrame.OpCode.Text &&
                        message.binaryPayload.size <= 32768
                )
                val data = JSONObject(message.textPayload)
                // The answer carries an SDP and the capability snapshot carries codec fmtp lines;
                // every other control message stays on the original two-kilobyte budget.
                val limit =
                    when (data.optString("type")) {
                        "rtc-answer" -> 32768
                        "rtc-diag" -> 4096
                        else -> 2048
                    }
                require(message.binaryPayload.size <= limit)
                lastSeen = SystemClock.elapsedRealtime()
                when (data.getString("type")) {
                    "audio-ready" -> {
                        val playback = data.getBoolean("playback")
                        val microphone = data.getBoolean("microphone")
                        if (!playback) sender.clearAudio()
                        WebSession.audio.ready(this, playback, microphone)
                    }
                    "audio-ack" -> {
                        val sequence = data.getLong("sequence")
                        require(sequence in 0..0xffff_ffffL)
                        sender.acknowledgeAudio(sequence)
                    }
                    "phone-connect" ->
                        WebSession.requestPhoneConnection(context) { result ->
                            if (viewer === this && !ended.get() && !closing.get()) {
                                reply(
                                    WebStreamSender.Control.PHONE_CONNECT,
                                    JSONObject()
                                        .put("type", "phone-connect-result")
                                        .put("message", result)
                                        .toString(),
                                )
                            }
                        }
                    "ack" -> if (imageProtocol == 3) sender.acknowledge(
                        data.getLong("sessionId"), data.getLong("videoEpoch"), data.getLong("sequence"))
                        else sender.acknowledge()
                    "image-format" -> if (imageProtocol == 3) {
                        when (data.getString("format")) {
                            "webp" -> if (!imageFallback) imageFormat = ImageFormat.WEBP
                            "jpeg" -> { imageFallback = true; imageFormat = ImageFormat.JPEG }
                            else -> error("Unsupported image format")
                        }
                        sender.frameAvailable()
                    }
                    "viewport" -> {
                        val width = data.getInt("width")
                        val height = data.getInt("height")
                        require(WebSession.reportBrowserViewport(width, height))
                    }
                    "ping" -> {
                        val transitions = data.optInt("liveTransitions", -1)
                        if (transitions >= 0 && transitions != lastLiveTransitions) {
                            Log.i(
                                "WheelPlayWeb",
                                "live-transitions t=${SystemClock.elapsedRealtime()} count=$transitions",
                            )
                            lastLiveTransitions = transitions
                        }
                        // Match service-stop lock ordering: take the session snapshot first.
                        val media = WebSession.mediaSnapshot()
                        reconcileVideo()
                        synchronized(rtcLock) {
                            val frame = media.frame
                            val mediaRtc = rtc.takeIf { rtcSource === media.source }
                            val rtcAvailable =
                                mediaRtc == null && rtcSource === media.source && rtcConfig != null &&
                                    rtcRetry.available && media.sourceState == "ready" &&
                                    !WebSession.localDisplayActive
                            if (rtcAvailable) {
                                val at = SystemClock.elapsedRealtime()
                                if (rtcAvailableSince == 0L) rtcAvailableSince = at
                                else if (!rtcNotRequested && at - rtcAvailableSince >= 15000) {
                                    // A head unit without RTCPeerConnection never sends rtc-start, so
                                    // without this line it is indistinguishable from plain JPEG.
                                    rtcNotRequested = true
                                    rtcHint = "rtc-not-requested"
                                    Log.i(
                                        "WheelPlayWeb",
                                        "rtc-not-requested waited=${at - rtcAvailableSince}ms " +
                                            "codec=${rtcConfig?.codec?.name ?: "none"}",
                                    )
                                }
                            } else rtcAvailableSince = 0L
                            reply(
                                WebStreamSender.Control.STATUS,
                                JSONObject()
                                    .put("type", "status")
                                    .put("width", media.width)
                                    .put("height", media.height)
                                    .put("mediaProtocol", imageProtocol.coerceAtLeast(2))
                                    .put("sessionId", media.sessionId)
                                    .put("videoEpoch", media.videoEpoch)
                                    .put("sourceState", media.sourceState)
                                    .put("inputReady", media.inputReady)
                                    .put(
                                        "stage",
                                        if (WebSession.localDisplayActive) context.getString(UiR.string.web_displayed_on_phone)
                                        else WebSession.stage(context),
                                    )
                                    .put(
                                        "streaming",
                                        !WebSession.localDisplayActive &&
                                            media.sourceState == "ready" &&
                                            (frame != null ||
                                                mediaRtc?.connected == true ||
                                                mediaRtc?.holdingFrame == true),
                                    )
                                    .put("rtcAvailable", rtcAvailable)
                                    .put("rtcHint", rtcHint ?: "")
                                    .put(
                                        "rtcDiag",
                                        listOfNotNull(
                                            rtcBindAddress?.let { "bind=$it" },
                                            rtcDiagnostics,
                                            rtcFallbackStates,
                                            rtcOffer?.profileLevelId?.let { "profile=$it" },
                                            rtcAnswer?.let {
                                                "answer=${it.media} setup=${it.setup} ${it.candidates}" +
                                                    if (it.mediaLines.isEmpty()) "" else " ${it.mediaLines}"
                                            },
                                            rtcLastFallback,
                                        ).joinToString(" "),
                                    )
                                    .put(
                                        "media",
                                        JSONObject().apply {
                                            mediaEcho?.let { put("echo", it) }
                                            CarPlayBackgroundSession.snapshot()?.controller
                                                ?.mediaSnapshot()?.let { playing ->
                                                    playing.title?.let { put("title", it.take(80)) }
                                                    playing.artist?.let { put("artist", it.take(80)) }
                                                    put("playing", playing.playing)
                                                }
                                        },
                                    )
                                    .put("rtcRetryAfterMs", rtcRetry.retryAfterMs)
                                    .put("rtcRetryBlocked", rtcRetry.blocked)
                                    .put("rtcFrames", mediaRtc?.sentFrames ?: 0)
                                    .put(
                                        "performance",
                                        JSONObject()
                                            .put(
                                                "source",
                                                rtcSource?.performanceSnapshot()?.let(::JSONObject),
                                            )
                                            .put("transport", rtc?.snapshot()?.let(::JSONObject))
                                            .put("image", JSONObject(sender.imageSnapshot())
                                                .put("format", media.frame?.format?.mime)
                                                .put("quality", media.frame?.quality)
                                                .put("encodedFps", media.encodedFps)),
                                    )
                                    .put(
                                        "transport",
                                        if (rtcSource?.jpegNeeded == false) "webrtc" else "jpeg",
                                    )
                                    .put(
                                        "fallback",
                                        rtcSource?.technology == StreamTechnology.WEBRTC &&
                                            (rtcRetry.attempted && rtc == null || rtcConfig == null),
                                    )
                                    .toString(),
                            )
                        }
                    }
                    "media" -> {
                        val action = data.getString("action").take(24)
                        require(action.all { it.isLetterOrDigit() })
                        val command = WebMediaKeys.command(action)
                        val controller = CarPlayBackgroundSession.snapshot()?.controller
                        val echo =
                            when {
                                command == null -> "media=$action→UNMAPPED"
                                controller == null -> "media=$action→NO_SESSION"
                                else -> {
                                    controller.sendMediaCommand(command)
                                        .whenComplete { result, _ ->
                                            val outcome = "media=$action→${result ?: "FAILED"}"
                                            synchronized(rtcLock) { mediaEcho = outcome }
                                            Log.i("WheelPlayWeb", "media $outcome t=${SystemClock.elapsedRealtime()}")
                                        }
                                    "media=$action→SENT"
                                }
                            }
                        mediaEcho = echo
                        Log.i("WheelPlayWeb", "media $echo t=${SystemClock.elapsedRealtime()}")
                    }
                    "rtc-start" -> startRtc()
                    "rtc-answer" ->
                        synchronized(rtcLock) {
                            if (data.getLong("id") == rtcId && rtc != null && !rtcAnswered) {
                                rtcAnswered = true
                                val sdp = data.getString("sdp")
                                rtcAnswer = RtcSdpSummary.summarize(sdp)
                                Log.i(
                                    "WheelPlayWeb",
                                    "rtc-answer id=$rtcId ${rtcAnswer?.describe()}",
                                )
                                rtc?.answer(sdp)
                            }
                        }
                    "rtc-diag" ->
                        synchronized(rtcLock) {
                            if (data.getLong("id") == rtcId) {
                                val answer = data.optJSONObject("answer")
                                if (answer != null) {
                                    // The browser's own view of the answer it produced; compare it
                                    // with the SDP-derived summary in rtc-answer when they differ.
                                    Log.i(
                                        "WheelPlayWeb",
                                        "rtc-diag id=$rtcId answer media=${answer.optString("media", "none")} " +
                                            "codecs=${answer.optString("codecs", "none").take(200)} " +
                                            "setup=${answer.optString("setup", "none")} " +
                                            "candidates=${answer.optString("candidates", "none")}",
                                    )
                                }
                                val codecs = data.optJSONArray("codecs")
                                val list =
                                    (0 until (codecs?.length() ?: 0))
                                        .mapNotNull { codecs?.optString(it)?.takeIf(String::isNotEmpty) }
                                val viewport = data.optString("viewport", "0x0")
                                if (data.has("hasPc")) {
                                    // Mime names only: the status line has room, and the answer's
                                    // m=video section decides whether a codec is really usable.
                                    val names =
                                        list.map { it.substringBefore(' ').removePrefix("video/") }
                                            .distinct().joinToString(",").take(80)
                                    // A capability snapshot; the answer summary above omits these.
                                    rtcDiagnostics =
                                        "hasPc=${if (data.optBoolean("hasPc")) 1 else 0} " +
                                            "hasRvfc=${if (data.optBoolean("hasRvfc")) 1 else 0} " +
                                            "hasStats=${if (data.optBoolean("hasStats")) 1 else 0} " +
                                            "dpr=${data.optDouble("dpr", 0.0)} vp=$viewport " +
                                            "screen=${data.optString("screen", "0x0")} " +
                                            "codecs=[$names]"
                                    Log.i(
                                        "WheelPlayWeb",
                                        "rtc-diag id=$rtcId $rtcDiagnostics " +
                                            "codecs=[${list.joinToString(" | ")}] " +
                                            "ua=${data.optString("ua").take(120)}",
                                    )
                                }
                            }
                        }
                    "rtc-feedback" ->
                        synchronized(rtcLock) {
                            if (data.getLong("id") == rtcId && rtc != null) {
                                fun counter(name: String): Long =
                                    data.getLong(name).also {
                                        require(it in 0..9_007_199_254_740_991L)
                                    }
                                val rtt =
                                    if (data.isNull("rttMs")) null
                                    else
                                        data.getDouble("rttMs").also {
                                            require(it.isFinite() && it in 0.0..60_000.0)
                                        }
                                rtc?.feedback(
                                    RtcReceiverHealth.Report(
                                        counter("packets"),
                                        counter("lost"),
                                        counter("decoded"),
                                        counter("nack"),
                                        rtt,
                                    )
                                )
                            }
                        }
                    "rtc-ready" ->
                        synchronized(rtcLock) {
                            if (data.getLong("id") == rtcId) {
                                rtcLastFallback = null
                                rtc?.displayed()
                                if (rtc?.holdingFrame == true) rtcRetry.ready()
                                sender.acknowledge()
                            }
                        }
                    "rtc-fallback" ->
                        synchronized(rtcLock) {
                            if (data.getLong("id") == rtcId) {
                                val retryable = data.optBoolean("retryable", true)
                                val reason = data.optString("reason", "unspecified").take(48)
                                // A rejected media section plus a Main/High profile is the only
                                // evidence that would justify the transcoding path; log it apart.
                                // codec-rejected never sends an answer, so the offer is the source.
                                val profile = rtcAnswer ?: rtcOffer
                                val profileMismatch =
                                    reason == "codec-rejected" &&
                                        profile?.mainOrHighProfile == true
                                // Only a first-frame timeout carries peer states; they separate an ICE
                                // that never completed from a stream that arrived but never decoded.
                                rtcFallbackStates = listOfNotNull(
                                    data.optString("conn").takeIf(String::isNotEmpty)?.let { "conn=$it" },
                                    data.optString("ice").takeIf(String::isNotEmpty)?.let { "ice=$it" },
                                    data.optString("gather").takeIf(String::isNotEmpty)?.let { "gather=$it" },
                                    if (data.optInt("track", 0) == 1) "track=1" else null,
                                ).joinToString(" ").takeIf { it.isNotEmpty() }
                                rtcLastFallback =
                                    "fallback=$reason" + (rtcFallbackStates?.let { " $it" } ?: "")
                                Log.i(
                                    "WheelPlayWeb",
                                    "rtc-fallback id=$rtcId reason=$reason retryable=$retryable " +
                                        "codec=${rtcConfig?.codec?.name ?: "none"} " +
                                        "profile=${profile?.profileLevelId ?: "none"}" +
                                        (if (profileMismatch) " profile-mismatch" else "") +
                                        (rtcFallbackStates?.let { " $it" } ?: "") +
                                        " t=${SystemClock.elapsedRealtime()}",
                                )
                                if (reason == "codec-unsupported" && rtcConfig?.codec == VideoCodec.H265) {
                                    // The iPhone, not the service, picks the codec. Remember the
                                    // answer so the same session stops re-offering HEVC and the
                                    // status line asks for the setting to change instead.
                                    hevcSupported = false
                                    rtcHint = "hevc-unsupported"
                                }
                                stopRtc(retryable)
                            }
                        }
                    "touch" -> {
                        val contacts = data.getJSONArray("contacts")
                        require(contacts.length() <= 2)
                        val list =
                            (0 until contacts.length()).map {
                                val point = contacts.getJSONObject(it)
                                AirPlayContact(
                                    point.getInt("id"),
                                    point.getDouble("x"),
                                    point.getDouble("y"),
                                    point.getBoolean("down"),
                                )
                            }
                        val accepted = if (versionedMedia) WebSession.mediaTouch(this,
                            data.optLong("sessionId", -1), data.optLong("videoEpoch", -1), list, lastSeen)
                        else WebSession.touch.touch(this, list, lastSeen)
                        if (!accepted) {
                            reply(
                                WebStreamSender.Control.INPUT_UNAVAILABLE,
                                """{"type":"input-unavailable"}""",
                            )
                        }
                    }
                    else -> error("Unknown message")
                }
            } catch (_: Exception) {
                disconnect(context.getString(UiR.string.ui_invalid_control_message))
            }
        }

        override fun onClose(
            code: WebSocketFrame.CloseCode?,
            reason: String?,
            initiatedByRemote: Boolean,
        ) = cleanup()

        override fun onException(exception: IOException) = cleanup()

        override fun onPong(pong: WebSocketFrame) {
            lastSeen = SystemClock.elapsedRealtime()
        }

        fun disconnect(reason: String) {
            cleanup()
            // Force close: no blocking close handshake on the watchdog/service thread.
            runCatching { handshakeRequest.inputStream.close() }
        }

        private fun cleanup() {
            if (!ended.compareAndSet(false, true)) return
            stopRtc()
            synchronized(this@LanWebServer) {
                if (viewer === this) {
                    WebSession.audio.detach(this)
                    viewer = null
                }
                WebSession.touch.drop(this)
            }
            sender.close()
            WebSession.viewerStateChanged()
        }
    }
}
