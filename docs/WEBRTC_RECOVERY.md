# WebRTC 稳定性与卡顿恢复

WebRTC 视频直通省去 Android 解码、像素读取和 JPEG 压缩，但稳定性取决于局域网 UDP、浏览器的 H.264 / HEVC 解码器，以及设备发送压缩帧的处理能力。JPEG 的每张图片能独立解码；压缩视频的预测帧依赖之前的参考帧，丢包或丢帧可能需要重传或等待新的关键帧。项目已使用 NACK 重传和 PLI 关键帧请求。

没有真机日志时，不能把所有卡顿归因于 WebRTC。此次代码检查发现，应用对可恢复异常的处理过于激进，而且浏览器与 Android 各有不同的回退阈值：

| 异常 | 原行为 | 当前行为 |
| --- | --- | --- |
| 浏览器 / 原生连接进入 `disconnected` | 立即回退 | 保留会话，等待所选容忍时间；重新连接后请求关键帧 |
| 原生发送返回失败 | 2 秒后回退 | 等待所选容忍时间，成功发送后取消本次计时 |
| 丢弃参考链后一直没有关键帧 | 3 秒后回退 | 持续有源帧但无法恢复时，等待所选容忍时间 |
| 源帧持续发送，接收端解码不前进 | Android 4 秒 / 浏览器 5 秒后回退 | 两端都使用所选容忍时间；Android 在停顿 2 秒后尝试请求关键帧 |
| 浏览器 `getStats()` 抛出异常 | 立即回退 | 暂时失败会重试；连续失败超过容忍时间才回退 |
| 首帧未显示 | 浏览器 8 秒 / Android 10 秒 | 两端都至少等待 10 秒；30 秒策略等待 30 秒 |
| 无 WebRTC、编码不支持、SDP 被拒绝、解码 / Canvas 出错、连接 `failed` | 立即回退 | 仍立即回退 |

静态画面没有新帧是正常现象。恢复更新时，浏览器不会把之前的静止时长计入解码停顿；发送队列等待关键帧时也会排除源画面的长时间暂停。解码恢复或连接恢复后，本次异常的计时会重置，已取消的定时器不会关闭后续会话。

## 设置与边界

「设置 → 画面与串流 → WebRTC 卡顿容忍时间」提供 **4 秒、10 秒（默认）、30 秒**。下次浏览器连接生效，策略随 `rtc-offer.recoveryGraceMs` 传到网页，浏览器与发送端使用同一策略。旧网页不支持该字段时，仍可能按旧逻辑提前回退，更新 App 后应刷新网页。

已显示视频时，恢复期间保持最后一帧，状态栏显示「等待恢复」，控制与音频通道继续工作。容忍时间用于等待恢复，**不是视频缓冲长度**：压缩队列仍限制为 50 ms、6 帧、2 MiB；参考链失效后丢弃预测帧并请求关键帧，恢复后显示新画面，避免积压延迟。计数检测约每秒一次，实际回退时刻会受采样与调度影响。

WebSocket 控制连接的心跳与重连规则独立于视频策略；整个网络连接中断时仍按原规则重连。原生 ICE / DTLS 状态已经变为 `failed` 时，延长容忍时间也不能让关闭的连接恢复。此改动未加入 ICE restart、TURN 或码率自适应。

浏览器的媒体源间隙由独立的[画面状态控制器](MEDIA_PRESENTATION.md)处理：短暂间隙保留画面、
暂停触控，恢复期限由独立定时器执行。视频重建通过版本代号隔离，JPEG 解码完成后才切换显示。
该显示策略不会改变这里的 WebRTC 传输恢复容忍时间。

## JPEG 回退后的自动重试

网络失败、发送 / 解码停顿或首帧超时导致回退后，服务端按 **5、10、20、30 秒**退避重试，
后续间隔保持 30 秒。冷却期从本次尝试结束时开始；现有网页心跳约每 400 ms 获取状态，
到期后的下一次状态消息触发新协商，实际时间受心跳和调度影响。此上限只约束重试间隔，
不缩短上面的连接恢复与首帧等待时间。

每个客户端的当前视频配置最多有一个协商。服务端统一控制冷却期，显式 `rtc-start` 也不能
跳过；网页无需额外重试定时器。协商期间 JPEG 继续更新，触控按当前 JPEG 的就绪状态工作，
只有视频首帧实际显示后才切回 WebRTC / Canvas。新尝试失败时继续保留 JPEG。

短暂成功不会清空失败次数；已确认显示视频至少 60 秒后再失败，下一次间隔恢复为 5 秒。
视频源或编码配置变化、浏览器重新连接会重置重试状态并允许立即尝试。旧 peer 的回调不能
结束新协商，断连后也没有残留的重试定时器。

明确的编码不支持、SDP 拒绝视频、浏览器 `NotSupportedError` / `NotAllowedError`、Canvas
2D 上下文不可用或原生传输库不可用，会停止当前配置的自动重试，避免持续创建必然失败的连接。
配置变化或重新连接后可重新尝试；浏览器没有 WebRTC API 时保持 JPEG。
临时 Canvas 绘制异常仍按可重试失败处理。

状态消息提供 `rtcAvailable`、`rtcRetryAfterMs`（剩余冷却毫秒数）和 `rtcRetryBlocked`。
网页可通过 `rtc-fallback.retryable: false` 报告上述不可重试错误；省略时按可重试处理。

## ICE 绑定地址

WebRTC 的 ICE socket 绑定到本次 WebSocket 连接在本机的 IPv4 地址（从已接受的 socket 读取，
用域名访问时同样有效；环回 / 链路本地地址不算），而不是默认的任意地址。这样兼容地址（如免 Root VPN 的 `6.6.6.6`）的 STUN 回包源地址与车机
发送目标一致，避免回包从热点地址发出而被丢弃。地址不是本机接口、为环回 / 链路本地或
绑定失败时保持任意地址，行为与旧版相同。`?diag=1` 状态行与 `rtc-offer` 日志都会记录 `bind=<地址|any>`；
`first-frame-timeout` 还会附带 `conn` / `ice` / `gather` / `track` 与 offer 的 `profile=`。仍需在目标
车机上验证 UDP 可达性。

## 失败归因（reason / rtc-diag）

所有立即回退过去都是一个不带原因的 `rtc-fallback`，服务端只关流不记日志，8 个阶段在日志里完全相同。现在回退报文固定携带 `reason`；收到 offer 时网页先发一次 `rtc-diag` 能力快照（UA、`RTCRtpReceiver` 的编码能力、`hasPc`/`hasRvfc`/`hasStats` 是否存在、dpr、视口与屏幕尺寸，限 1 KB），answer 生成后再发一条同类型消息，携带网页自己解析的 answer 摘要（`m=video` 端口、rtpmap/fmtp、`a=setup`、候选 host/srflx/relay/mdns 计数）。两条都不发送完整 SDP。

| reason | 含义 | 定向动作 |
| --- | --- | --- |
| `rtc-not-requested` | 服务端可见 WebRTC 能力，但 15 秒内没有收到 `rtc-start`（车机没有 `RTCPeerConnection`） | 走能力提示，不再折腾 SDP |
| `codec-unsupported` | `supportsCodec` 返回 false；能力列表为空时不再判定为不支持，交由 SDP answer 决定 | 关闭 iPhone HEVC；服务端会记住并停止再发 H.265 offer |
| `codec-rejected` | answer 出现 `m=video 0` | profile 为 `4d`/`64` 时日志附带 `profile-mismatch`，才考虑转码 |
| `offer:*` / `answer:*` | `setRemoteDescription` / answer 生成抛错 | 按 `err.name` 决定是否净化 SDP |
| `local-desc:*` | DTLS 角色改写后 `setLocalDescription` 抛错 | 已自动用原始 `a=setup:active` 重试一次 |
| `gathering-timeout` 相关 | 候选收集 3 秒未 complete | 已改为到时发送已收集候选，不再等首帧超时 |
| `first-frame-timeout` / `decode-error` / `play:*` | 解码或播放启动失败 | 用 `?unhide=1` 验证是否为隐藏 video 不解码；`first-frame-timeout` 会附带 `conn` / `ice` / `gather` / `track`，`conn` 停在 `checking` 是 ICE 未通，`conn=connected track=1` 才是解码问题 |
| `decode-stall` / `stats-unavailable` | 解码不前进 / 取统计连续失败 | 网络与丢包排查 |
| `connection:<state>` / `disconnect-timeout` | 连接终态 / 短暂断开超时 | 见上文容忍时间策略 |
| `renderer-error` / `render-stalled` / `track-ended` / `track-replaced` | 渲染器报错、画面不再更新、轨道结束或被替换 | 换一个视频渲染器对比；`render-stalled` 时检查绘制路径而不是网络 |
| `processor-unsupported` | 「直接 Canvas」缺少 `MediaStreamTrackProcessor` | 改回原生 Video 或兼容 Canvas |

服务端日志（tag `WheelPlayWeb`）新增：

- `rtc-offer id=.. codec=.. bind=<地址|any> media=video:9 codecs=<rtpmap + fmtp> setup=actpass candidates=host:N,srflx:N,relay:N,mdns:N`
- `rtc-answer id=.. ...`（同上；`media=video:0` 即被拒）
- `rtc-fallback id=.. reason=.. retryable=.. codec=.. profile=.. [profile-mismatch] [conn=.. ice=.. gather=.. track=1] t=..`（只有 `first-frame-timeout` 会带 peer 状态）
- `rtc-diag id=.. hasPc=1 hasRvfc=1 hasStats=1 dpr=.. vp=.. screen=.. codecs=[..] ua=..`
- `rtc-diag id=.. answer media=video:9 codecs=<rtpmap + fmtp> setup=passive candidates=host:N,srflx:N,relay:N,mdns:N`（网页端视角）
- `rtc-not-requested waited=..ms codec=..`（能力可见但浏览器从未请求）

`?diag=1` 状态行还会拼上 answer 摘要（`answer=video:N setup=… candidates=…`）和最近一次回退
（`fallback=<reason> conn=… ice=… gather=… [track=1]`）。回退记录保留到下一次成功显示首帧为止，
重试间隙拍屏也能看到；`mdns` 候选数、`setup` 角色和 `conn` 状态是判断车机端卡在哪一步的依据。

车机上可用 `?diag=1` 看到 WebRTC 现场：状态行只保留简短的 ` · WebRTC: <reason|ok|idle>`（顶栏高度固定，长文本会溢出遮住画面），能力快照与上面的 answer / fallback 详情一起放进画面左下角的独立诊断框（可滚动、不拦截触控），不依赖 devtools / adb；`?unhide=1` 让首帧前的 video 保持视口内 1 px、`opacity:0`  的布局盒（`pending-video`）而不是 `display:none`，用于验证老 Chromium 是否不解码隐藏元素（原生 Video 与兼容 Canvas 模式有 video 元素；直接 Canvas 模式不需要）。二者都只是开关，默认行为不变。HEVC 被拒后状态栏会提示「在 WheelPlay 设置中关闭 HEVC 才能在此车机上使用 WebRTC」。

## 排查与真机验证

浏览器控制台的 `window.wheelplayStats` 提供分段指标。`transport.recoveryGraceMs` 可核对当前策略；Android 的 `WheelPlayRtc` 日志记录发送、关键帧、解码、连接或首帧超时等回退原因。

- `expiredFrames` / `overflowFrames` 持续上升：优先检查 Android CPU 调度、发送耗时和帧大小。容忍时间能等待关键帧恢复，但不会消除持续过载。
- 发送速率正常，接收速率下降，`lost` / `nack` / RTT 升高：优先检查 Wi-Fi 信号、热点负载、UDP 限制。HTTP 能访问不代表 WebRTC 的 UDP 路径正常；项目没有外部 STUN / TURN。
- 接收正常，解码速率停顿：检查浏览器编码兼容性，先禁用 iPhone HEVC，使用 H.264 对比。
- 解码正常，呈现停顿：检查车机浏览器视频渲染，可对比网页的「兼容 Canvas」与「直接 Canvas」实验选项。

真机需分别验证 4 / 10 / 30 秒策略：播放动态画面，制造短于阈值的 UDP 丢包或短暂断开，确认保留 WebRTC 并恢复新画面；持续阻断超过阈值，确认回退 JPEG，并按退避间隔尝试新连接；解除阻断后确认 JPEG 持续显示和可操作，视频首帧到来后切回；静态画面停留一分钟后操作，确认没有立即回退；再检查触控、音频和浏览器自动重连。自动化测试覆盖策略、超时边界、重试与会话隔离，但不能证明某款 Tesla 浏览器或热点的实际兼容性。

## 直接 Canvas 的恢复与回退

直接 Canvas 缺少主线程 Processor 时不请求 WebRTC，保留图像串流（JPEG / WebP）；前端仍记录 `processor-unsupported` 并显示提示，不依赖服务端 fallback 字段。已收到 offer 后发现不可用时发送匹配 ID 的 rtc-fallback。Processor 构造、读取、绘制错误或轨道意外结束立即回退；回退保留控制和音频通道，释放触点、reader 及 Canvas 缓冲，不转用旧 Video 模式。

首次成功绘制之前保持 JPEG，首帧等待 `max(10000ms, recoveryGraceMs)`。持续发送时分别检查解码和绘制进展，即使 framesDecoded 增长而画布不再更新，也会在所选容忍时间后回退。没有新输入的静态画面不触发渲染停滞；恢复输入时重新计时。连接短暂断开时仍保留最后一帧。

`presentation.fallbackReason` 区分 processor-unsupported、renderer-error、track-ended、track-replaced、first-frame-timeout、decode-stall、render-stalled、stats-unavailable、connection:<state>、disconnect-timeout、codec-unsupported 等原因；server-stop 表示服务端停止本次媒体。选择保留；可恢复错误沿用上游有界退避重试，缺少 Processor、Canvas 2D 或明确的平台不支持错误停止当前配置的重试，重新连接或配置变化后再尝试。直接 Canvas 状态栏使用 renderedFps，原生 Video 与兼容 Canvas 继续使用 presentedFps / decodedFps。
