# CarPlay 手机内显示「触控大坑」复盘

> 记录「在本机显示 CarPlay 画面」功能里，手机内显示能正常渲染、但**触控点不动 / 只有高亮没反应 / 部分区域失效**这一系列问题的完整排查过程、真正根因与最终修复。供后续维护与踩坑参考。

## 1. 背景

- 本项目接收 iPhone 的 CarPlay 画面，主流场景是**串流到车机浏览器**（WebRTC）。
- 新增需求：在手机 App 内直接显示 CarPlay 画面（`CarPlayLocalPreviewActivity`），并支持把触摸回传给 iPhone 操作 CarPlay。
- 现象：画面能显示，但**中间能点、边缘点不动**；进一步是**大部分区域只有按下高亮、不触发功能**，只有少部分能真正生效。而**浏览器串流场景触控一直正常**。

## 2. 走过的弯路（错误假设）

排查过程中先后怀疑并被证伪的方向，列出来避免重走：

1. **「WebRTC 与本地解码并行导致资源/时序问题」** → 与触控无关（后改为互斥：进手机显示即停浏览器推流）。
2. **「自适应重连改变了分辨率，导致坐标系错位」** → 关掉自适应后现象依旧，排除。
3. **「华为系统 overlay（状态栏 / 手势导航边缘）拦截了真实触摸」** → 一度非常像：`dumpsys window` 确实显示状态栏 `[0,0][2400,240]`、`GestureNavLeft [0,112][48,1080]` 压在应用之上；一度加了「安全区内缩」绕开边缘。但后来发现**真实触摸其实能到达应用**（日志可见 DOWN/MOVE/UP 全部 `sent=true`），内缩只是把问题掩盖了一部分，且牺牲了全屏。
4. **「触控 HID 事件类型/槽位参数错」** → 与浏览器共用同一条 `controller.sendTouch → AirPlaySession.sendTouch → AirPlayHid.touchReport` 链路，浏览器正常，说明编码没问题。

## 3. 关键排查手段（真机 + adb）

这些手段是破局点，值得沉淀：

- **注入点击 vs 真实手指对比**：`adb shell input tap x y` 能触发、真实手指不行 → 说明差异在「事件如何被派发/映射」，而非 iPhone 侧。
- **原始输入取证**：`adb shell getevent -lt /dev/input/eventN` 确认真实手指**确实产生了 BTN_TOUCH DOWN/UP**，即输入系统收到了。
- **窗口/输入栈取证**：`adb shell dumpsys window windows` / `dumpsys input` 看焦点窗口、各窗口 `mFrame`、`touchableRegion`、`inputConfig`，确认应用窗口是焦点且可触摸。
- **应用内日志插桩**：在触摸回调里打印 `action / pointerCount / raw / view 尺寸 / 归一化 norm / sent`，看清一次点击的完整生命周期。
- **画面取证**：`adb exec-out screencap -p` 看实际渲染（是否拉伸、黑边、dock 位置）。

## 4. 真正根因

手机显示最初用 **`SurfaceView`**：

- `SurfaceView` 会把解码帧**直接拉伸铺满自身矩形**（不保持宽高比、不信箱），于是：
  - 画面**拉伸变形**（关掉自适应、视频比例≠屏幕比例时尤其明显）。
  - 触控按「整个 SurfaceView 尺寸」归一化，而**画面真实内容矩形与 SurfaceView 矩形并不一致**（存在信箱/偏移），导致按下位置与实际控件对不上 → **按下能触发高亮（坐标大致对），但精确命中/抬起判定失败 → 不触发功能**；越靠边缘偏差越大 → 边缘基本失效、中间勉强可用。

一句话：**渲染用了「拉伸铺满」，触控却按「整 view 归一化」，两者对不上。** 浏览器不出问题，是因为 `<video>` 用 `object-fit: contain` 保持比例，并用 `mapPoint` 按**视频真实矩形**换算触控。

## 5. 正确修复（对齐上游 DiPlay）

参考可直接正常工作的上游 DiPlay（本项目上游的上游），把手机显示改为：

1. **改用 `TextureView` 渲染**，用 `setTransform(Matrix)` 做**等比 contain 适配**：
   - `content = CarPlayVideoLayout.fit(视频真实尺寸, view 尺寸)`
   - `matrix.setScale(content.width/viewW, content.height/viewH); matrix.postTranslate(content.left, content.top)`
   - 画面按真实比例居中显示，**不拉伸**。
2. **触控走同一个「内容矩形」**：`CarPlayTouchMapper.contacts(event, content)`
   - 归一化时**减去 `content.left/top`、除以 `content.width/height`**，与渲染矩形严格一致。
3. **忽略落在黑边上的整段手势**：`ACTION_DOWN` 时若 `!content.contains(x,y)` 置 `touchOutsideContent`，整段忽略到 UP/CANCEL，避免在黑边起手的幻影点击。
4. 视频真实尺寸优先取解码器输出的可见帧尺寸（含 crop）`AndroidMediaSink.localDisplayIntrinsicSize(type)`，回退到协商分辨率 `localDisplayWidth/Height`。

涉及文件：

- `common/.../CarPlayLocalPreviewActivity.kt`：`SurfaceView` → `TextureView` + `applyVideoTransform` + `contentRect` + `forwardTouch`（内容矩形映射 + 黑边忽略）。
- `shared/.../media/CarPlayVideoLayout.kt`：新增（从 DiPlay 移植，`fit()` 计算等比内容矩形）。
- `shared/.../media/CarPlayTouchMapper.kt`：新增 `contacts(event, content: CarPlayVideoLayout)` 重载。

## 6. 顺带解决/保留的相关点

- **全屏**：去掉为「绕开 overlay」而加的安全区内缩后，画面铺满顶/左（映射已修对，边缘触控不再受该 bug 影响）；`layoutInDisplayCutoutMode=ALWAYS` + 沉浸式隐藏系统栏。
- **互斥切换**：进手机显示 → 停浏览器推流、停浏览器触控、车机端显示「已在手机显示」提示；退出 → 恢复推流。
- **自适应重连**：开启「自适应屏幕尺寸」时按屏幕比例重协商分辨率（会重连一次）。
- **加载提示**：重连重建会话期间显示加载遮罩，`onSurfaceTextureUpdated` 首帧到达即隐藏。

## 7. 经验清单（下次直接照做）

- 手机本地显示视频 + 需要精确触控时，**默认用 `TextureView` + 等比 transform**，不要假设 `SurfaceView` 会保持比例；`SurfaceView` 是拉伸铺满。
- **渲染矩形 == 触控换算矩形**：两者必须用同一个内容矩形（`CarPlayVideoLayout.fit`），否则必现「高亮不触发 / 边缘失效」。
- 排查真机触控，先做**注入 vs 真实**对比，再 `getevent` 看输入是否到达、`dumpsys window/input` 看窗口与 `touchableRegion`，最后在应用回调里打印完整事件序列——不要靠猜。
- 遇到「浏览器对、本地不对」，优先怀疑**本地渲染/坐标映射**差异，而不是触控协议本身（协议常是共用的）。
- 有可用的上游实现（DiPlay）时，**先读它怎么做的**再动手，往往一步到位。
