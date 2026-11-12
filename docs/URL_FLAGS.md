# 浏览器 URL 参数速查表

车机浏览器没有 devtools、也无法看 logcat，因此诊断与故障隔离能力做成了地址栏上的隐藏开关。
**不带任何参数就是正常用户路径**；这些开关只影响当前这次页面加载，不写进设置面板、不存
localStorage，多个参数用 `&` 连接（例如 `?manual=1&diag=1`）。它们都是纯前端开关，不改变
服务端的访问控制：`/stream` 的令牌校验、同源校验与单 viewer 限制照旧，诊断快照也不含配对
凭据和视频载荷。

解析集中在 `common/src/main/assets/web/url-flags.js`，每个参数都有自己的白名单，**非法值等同
于没带**，不会把任意字符串灌进连接状态机。

## 速查表

| 参数 | 默认值 | 作用 | 适用 | 详细文档 |
| --- | --- | --- | --- | --- |
| `?code=xxxxxx` | 无 | 用六位配对码直连，二维码不可用时的备用入口 | 用户 | [架构与协议](ARCHITECTURE.md) |
| `?manual=1` | 关闭（自动连接） | 恢复「扫码／配对码 + 点击启动」的手动页面 | 用户／排查 | [架构与协议](ARCHITECTURE.md) |
| `?diag=1` | 关闭 | 画面左下角诊断框 + 状态行的 `WebRTC: <reason>` | 用户／排查 | [WebRTC 恢复](WEBRTC_RECOVERY.md)、[图片串流](IMAGE_STREAM.md) |
| `?unhide=1` | 关闭 | 首帧前的 `<video>` 保持视口内 1 px 透明布局盒 | 排查 | [WebRTC 恢复](WEBRTC_RECOVERY.md) |
| `?ms=1` / `?ms=2` | 关闭 | 接管车机媒体会话、转发方向盘媒体键；`2` 额外用媒体元素播放音频 | 高级用户 | [浏览器音频](BROWSER_AUDIO.md) |
| `?audioIdle=<毫秒>` | `5000`，`0` 为常开 | 最后一路声音结束后释放音频输出的等待时间 | 车机适配 | [浏览器音频](BROWSER_AUDIO.md) |
| `?rtcexp=noanswer\|inactive` | 关闭 | 蓝牙冲突定位实验：分别停在「解析 offer」与「媒体流动」之前 | 内部实验 | [浏览器音频](BROWSER_AUDIO.md)、[WebRTC 恢复](WEBRTC_RECOVERY.md) |

## 逐项说明

### 配对：`?code=xxxxxx` 与 `?manual=1`

默认打开网页即自动建立信任并连接：`/pair/auto` → `/pair/remember` → `/pair/resume` → WebSocket，
不需要扫码。`?manual=1` 回到旧的二维码／配对码页面，用于排查配对问题。`?code=` 接受六位数字，
配对完成后立刻用 `replaceState` 从地址栏抹掉，避免短时凭据留在浏览器历史里。

### 诊断：`?diag=1`

抽屉底部的「进入调试模式」按钮就是在当前地址上加减这个参数并刷新（其它参数会保留）。
诊断框包含协商 / 解码 / 回退快照（`cap secure/vd/hevc`、`startId/skips/closes/rejects/rec`、
`cs=` 阶段轨迹）、`ws dec … fps` 或 `img enc/tx/ack` 吞吐，以及 `scheme=light/dark`。
诊断框里的 `rec=` 是首帧提交失败后的自愈次数（见 [媒体呈现](MEDIA_PRESENTATION.md)），正常首次连接应为 0。
开启 `?ms` 时还会多一行 `ms=… api=… key=… last=…`。

### 显示排障：`?unhide=1`

某些嵌入式浏览器不会解码 `display:none` 或移到视口外的 `<video>`，表现为 WebRTC 首帧一直超时、
自动回退 JPEG。这个开关把首帧前的 video 留在视口内（1 px、`opacity:0`），用来验证是不是这个原因。
只对「原生 Video」与「兼容 Canvas」模式有意义，直接 Canvas 模式没有 video 元素。

### 媒体会话：`?ms=1` / `?ms=2`

**媒体卡片（标题／艺人／封面）默认就会发布，不需要任何参数。** `?ms=1` 额外注册
`navigator.mediaSession` 动作处理器，把收到的按键经 WebSocket 原样转发给 CarPlay，并把
`playbackState` 恒设为 `playing`（否则 Chrome 会释放平台会话、车机不再投递按键）；`?ms=2`
再把 WebAudio 输出接到一个正在播放的 `<audio>` 元素，因为 Chrome 只把平台媒体键交给
「有媒体元素在出声」的标签页。

实测边界：这台 Tesla 车机只把「暂停」投递给页面，切歌属于 AVRCP、只在蓝牙音频在线时发给手机，
页面收不到；需要方向盘切歌应改用「WebCodecs 视频通道」或图片通道。

### 音频输出：`?audioIdle=<毫秒>`

车机会把一个开着音频输出（哪怕静音）的页面当作音乐源，跟手机蓝牙反复抢媒体卡片。因此最后一路
声音结束后默认等 5 秒就挂起 AudioContext（`?ms=2` 时同时暂停媒体元素），下次提示音或通话到达
再打开；挂起期间收到的帧会入队，不丢帧。`0` 关闭自动释放，适合必须常开 sink 的车机。
只接受非负整数，其它值回退到默认 5000。

### 内部实验：`?rtcexp=noanswer|inactive`

- `noanswer`：只解析 offer，不创建 PeerConnection、不回答，15 秒后以 `exp:noanswer` 回退。
- `inactive`：正常握手，但把 answer 的媒体方向改成 `a=inactive`，ICE/DTLS 建成而 RTP 不流动，
  首帧超时后以 `exp:inactive-first-frame` 回退。

用来区分「收到 offer」「传输建立」「媒体流动」三个阶段中，究竟是哪一步触发车机掐断手机的
A2DP 蓝牙。结论已记录在 `WEBRTC_RECOVERY.md`：触发点是 WebRTC 媒体传输本身，页面侧无解，
需要蓝牙音频时改用 WebCodecs 视频通道。保留该分支是为了在新车型／新固件上能重新复现验证。

## 已移除的参数

`?auto=1` 早期用于「免点击自动连接」，自动信任成为默认路径后代码已不再解析它；旧文档里的
说明和示例已删除。带上它没有任何效果，也不再需要兼容处理。

## 相关代码

- 解析与白名单：`common/src/main/assets/web/url-flags.js`（单测 `test/url-flags.test.js`）
- 消费点：`app.js`（配对、诊断面板、renderer、媒体会话、音频空闲）
- 模块行为单测：`test/webrtc.test.js`、`test/browser-audio.test.js`、
  `test/browser-media-session.test.js`、`test/video-canvas.test.js`
