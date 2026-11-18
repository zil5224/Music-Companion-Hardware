# 0-8A OLED 中文显示协议方案

> 状态：**Phase 1 已完成并实板验收通过**（静态测试屏、最小 Watch、显示期间应用命令、复位/拔插恢复、拔 OLED 的 `IO_ERROR`）。**Phase 2 已完成并实板验收通过**（2026-11-16 用户手动确认：自动跟随、切歌、暂停/恢复、拖动进度、跟随期间应用命令、无卡顿、测试屏停留、断开重连）。**Phase 3（实时频谱）已完成并实板验收通过**：布局「歌名 24 / 歌手 16 / 频谱 16 / 进度 8」，`31-oled-spectrum.js`（Analyser 24 柱对数频段、约 8 Hz、暂停冻结最后一帧），全量 437/437、真实 Chrome 假 Web Serial E2E 通过；**实板 2026-11-16 用户确认通过**（含 24 柱/两侧 5 px 留白观感）。歌手/时间 14/12 px、歌名 22 px 常规（不加粗）已经实板确认。**长歌名 >4 字滚动已实现（33 号模块），待实板复核。**0-7A 实板已由用户确认通过（Watch 未测，用户决定跳过）。第 13 节开放问题已于 2026-11-16 确认并冻结，Phase 3 决策见第 13 节第 1 条。

## 1. 目标与范围

- 网页端把中文歌名、歌手、进度/时间、实时频谱渲染成 **1bpp 单色位图**，经 USART1 分片传给 STM32；STM32 写入现有 SSD1306 framebuffer 并局部刷新。
- **不在 STM32 Flash 存中文字库**；中文字形全部由网页端栅格化。
- 复用现有 V1.0 帧、CRC、SEQ；复用现有 OLED 驱动的 1024 B framebuffer、`DrawBitmap`、`FlushRegion`。
- 不新增 FreeRTOS 任务、不做动态内存分配、不破坏 0-4C/0-7A 已实板验证的行为。
- Phase 1/2 做静态文字与进度；Phase 3 按用户 2026-11-16 决定纳入**实时条形频谱**（歌名/歌手字体缩小让位），仍复用同一套 BEGIN/DATA/END 协议。

## 2. 现有基础

| 项 | 现状 |
|---|---|
| 帧格式 | SOF `A5 5A`、VER `01`、TYPE、SEQ、LEN、PAYLOAD、CRC16；最大 payload 256 B |
| 0-7A | 应用命令 `0x10–0x13`、ACK `0x90`；实板通过 |
| OLED 驱动 | SSD1306 128×64、I2C1 PB8/PB9 100 kHz、1024 B framebuffer |
| 位图 API | `ZILY_OLED_DrawBitmap(x,y,w,h,data,len)`：逐行 1bpp、MSB 在左、`1` 点亮、`0` 熄灭、**不透明**（0 会写入） |
| 区域刷新 | `ZILY_OLED_FlushRegion(x,y,w,h)`：只发指定列与覆盖页；边界页同列、区域外像素按 framebuffer 当前值发送 |
| 执行上下文 | 协议解析和回复在 UART 任务（优先级 3）同步执行；OLED 自检在调度器启动前完成 |

## 3. TYPE 分配

| TYPE | 名称 | 方向 | 说明 |
|---:|---|---|---|
| `0x40` | DISPLAY_BEGIN | PC → STM32 | 开始一次区域传输 |
| `0x41` | DISPLAY_DATA | PC → STM32 | 一个分片 |
| `0x42` | DISPLAY_END | PC → STM32 | 结束并刷新 |
| `0x43` | DISPLAY_ABORT | — | 预留，V1 不实现；新 BEGIN 即中止旧会话 |
| `0x44–0x4F` | — | — | 显示类预留（清屏、图标、亮度等） |
| `0x91` | DISPLAY_ACK | STM32 → PC | 显示传输应答 |
| `0x92–0x9F` | — | — | 显示应答预留 |

`0x01–0x04`、`0x10–0x13`、`0x90` 保持不变；`0xC0–0xEF` 仍留给实体按键事件。帧布局、VER、CRC 不变。

**不复用 `0x90`**：它的载荷语义是 `[CMD, STATUS, STATE]`，STATE 对显示无意义；显示用独立的 `0x91`，载荷 `[CMD, STATUS, NEXT_CHUNK]`。

## 4. 传输模型

- **单会话 + 停等（stop-and-wait）**：主机一次只发一个分片，收到 `0x91 ACK` 再发下一个。适合 115200 和低频 UI 更新，MCU 只需一个接收缓冲。
- 一次显示更新 = `BEGIN` → N × `DATA` → `END`。
- 主机侧 `SEQ` 仍由现有传输层管理（每个请求独立 SEQ）；`session` 和 `chunk` 是显示会话自己的重装序号，两者不要混淆。
- 固件侧显示会话状态独立于 0-7A 应用命令；应用命令可以在两个分片之间插入，互不影响。
- 新 `BEGIN` 无条件取代旧会话（用于中止/重传）；V1 不做会话超时。

## 5. 命令格式

### 5.1 DISPLAY_BEGIN（`0x40`，LEN=9）

| 偏移 | 字段 | 长度 | 说明 |
|---:|---|---:|---|
| 0 | session | 1 B | 0–255，主机递增 |
| 1 | x | 1 B | 区域左上角 X |
| 2 | y | 1 B | 区域左上角 Y |
| 3 | width | 1 B | 区域宽，1–128 |
| 4 | height | 1 B | 区域高，1–64 |
| 5 | format | 1 B | `0` = 1bpp 行优先、MSB 在左 |
| 6–7 | totalBytes | 2 B | 小端，位图总字节数；必须等于 `ceil(width/8)×height`，最大 1024 |
| 8 | totalChunks | 1 B | 分片总数；固定分片 240 B 时 = `ceil(totalBytes/240)`，最大 5 |

校验：`x+width ≤ 128`、`y+height ≤ 64`、`width>0`、`height>0`、`format=0`、`totalBytes` 匹配、`totalChunks` 匹配；否则 `BAD_PAYLOAD`。

### 5.2 DISPLAY_DATA（`0x41`）

| 偏移 | 字段 | 长度 | 说明 |
|---:|---|---:|---|
| 0 | session | 1 B | 必须等于当前会话 |
| 1 | chunk | 1 B | 0 基分片号 |
| 2–3 | offset | 2 B | 小端，该分片在整张位图中的字节偏移 |
| 4.. | data | 1–240 B | 位图字节；最后一片可小于 240 |

**固定分片 240 B**：`offset = chunk×240`；`len = min(240, totalBytes−offset)`；最后一个分片可小于 240。`LEN=4+len`，最大 244（帧长 254）。

固件按**严格校验**实现：`offset` 必须正好等于 `chunk×240`，`len−4` 必须正好等于该分片的期望长度，否则 `BAD_PAYLOAD`。这样任何短帧或错位帧都不可能写到缓冲区之外，也不会留下"半截"位图。

### 5.3 DISPLAY_END（`0x42`，LEN=2）

| 偏移 | 字段 | 长度 | 说明 |
|---:|---|---:|---|
| 0 | session | 1 B | 必须等于当前会话 |
| 1 | flags | 1 B | bit0=1 立即 `FlushRegion`；V1 固定 `01`，其余位保留 0 |

V1 固件只接受 `flags = 0x01`；其它取值回 `BAD_PAYLOAD` 且保留会话，主机可用正确 flags 重发 END。

### 5.4 DISPLAY_ACK（`0x91`，LEN=3）

| 偏移 | 字段 | 长度 | 说明 |
|---:|---|---:|---|
| 0 | CMD | 1 B | 回显请求 TYPE（`0x40/0x41/0x42`） |
| 1 | STATUS | 1 B | 结果 |
| 2 | NEXT_CHUNK | 1 B | 下一个期望分片号；非 DATA 应答填 0 |

`NEXT_CHUNK` 的实际取值规则（主机以它为准做重发/续传，不信任自己的计数）：

- `BEGIN` 成功、`END` 成功、`BAD_SESSION`：0；
- `DATA` 的 `OK`/`BAD_CHUNK`/`BAD_PAYLOAD`：固件当前 `nextChunk`；
- `END` 的 `BAD_PAYLOAD`（数据不完整）：0（会话已经结束）。

### 5.5 STATUS

| 值 | 名称 | 含义 |
|---:|---|---|
| `0x00` | OK | 已接受/已刷新 |
| `0x01` | UNSUPPORTED | 保留的显示 CMD（`0x44–0x4F`）；`format≠0` 属于 `BAD_PAYLOAD` |
| `0x02` | BAD_PAYLOAD | 几何、长度、分片数、offset 或 END 数据不完整 |
| `0x03` | BAD_SESSION | 无活动会话或 session 不匹配 |
| `0x04` | BAD_CHUNK | 分片号乱序；`NEXT_CHUNK` 给出期望值 |
| `0x05` | BUSY | 预留（同步执行，V1 不应出现） |
| `0x06` | INTERNAL | `DrawBitmap` 失败等内部错误 |
| `0x07` | IO_ERROR | `FlushRegion` 返回 I2C 错误 |

## 6. 状态机与错误处理

固件会话状态：`active`、`session`、`x/y/w/h`、`format`、`totalBytes`、`totalChunks`、`nextChunk`、`receivedBytes`。

| 事件 | 处理 |
|---|---|
| BEGIN 合法 | 覆盖旧会话，保存参数，ACK `OK` + `NEXT_CHUNK=0` |
| BEGIN 非法 | ACK `BAD_PAYLOAD`，不改变现有会话 |
| DATA 的 `chunk == nextChunk` | 严格校验 `offset == chunk×240` 与 `len == min(240, totalBytes−offset)`；通过后拷贝到 `displayBuffer[offset]`，`nextChunk++`，ACK `OK` + 新 `nextChunk`；不通过 ACK `BAD_PAYLOAD` + 当前 `nextChunk` |
| DATA 的 `chunk == nextChunk−1` | 视为重传：不重复拷贝，直接 ACK `OK` + 当前 `nextChunk` |
| DATA 其它 chunk | ACK `BAD_CHUNK` + `NEXT_CHUNK=nextChunk`，不改变状态 |
| DATA/END 无会话或 session 不匹配 | ACK `BAD_SESSION` |
| END 时 `nextChunk != totalChunks` 或字节数不足 | ACK `BAD_PAYLOAD`，结束会话（主机需重新 BEGIN） |
| END 完整：`DrawBitmap` 失败 | ACK `INTERNAL`，保留会话，允许重发 END |
| END 完整：`FlushRegion` 失败 | ACK `IO_ERROR`，保留会话，允许重发 END（重绘+重刷是幂等的） |
| END 成功 | ACK `OK`，清会话 |

- **重传**：主机对超时或 `BAD_CHUNK` 的分片，用相同 session/chunk/offset 重发一次；仍失败则放弃本次显示更新（保留旧画面），下一次更新重新 BEGIN。
- **不自动无限重试**；显示更新失败只记日志，不影响播放/AI/应用命令。
- **无会话超时**：主机崩溃留下的会话由下一次 BEGIN 覆盖；固件状态很小，无副作用。
- **`0x43` 静默**：预留位，不产生任何 ACK，走现有未知类型路径静默计数。
- **`0x44–0x4F`**：回 `0x91 [TYPE, 0x01 UNSUPPORTED, 0x00]`，让主机能区分"显示类已实现"和"链路无响应"。
- **UART 任务阻塞**：END 的 `DrawBitmap + FlushRegion` 在 UART 任务内同步执行。全屏 I2C 约 100 ms、整次全屏更新约 200 ms；期间 RX ISR 继续入 512 B 环，主机停等不会继续发，应用命令会排队到刷新后处理。

## 7. 位图格式与 UI 区域

- 格式：逐行 1bpp，MSB 在左，`1` 点亮，`0` 熄灭；行跨度 `ceil(width/8)`；总字节 `stride×height`。
- **不透明**：主机必须把区域内的背景也画成 0，`DrawBitmap` 会覆盖区域内全部像素，不需要单独清屏。
- 推荐区域按 8 像素边界布局：`x`、`width` 为 8 的倍数，`y`、`height` 为 8 的倍数。这样 `FlushRegion` 边界页不会带入无关像素，也方便局部刷新。
- 定稿布局（固件不写死，主机按此实现，实板验收也按此观察）：

| 区域 | 坐标 | 大小 | 内容 |
|---|---|---|---|
| 歌名 | x=0, y=0 | 128×24 | 中文大字号（**22 px 常规体，不加粗**——18 px bold 在 1bpp 下笔画会粘）；**≤4 字静态居中；>4 字窗口滚动** |
| 歌手 | x=0, y=24 | 128×16 | 左侧中文歌手名（14 px）；**右侧右对齐 `m:ss` 时间**（12 px ASCII） |
| 频谱 | x=0, y=40 | 128×16 | **实时 24 柱条形频谱**：柱宽 3 px、间隔 2 px（24×3+23×2=118，居中后两侧各留 5 px），底对齐；对数频段 60 Hz–16 kHz |
| 底部 | x=0, y=56 | 128×8 | **整宽进度条，实心条高 2 px**（上下各留 3 px 黑边；时间不占底部） |

四区都按 8 像素边界对齐（0/24/40/56），每次局部刷新都落在完整页内。Phase 3 按用户要求加入实时频谱并缩小歌名/歌手字号：歌名 32→24 px、歌手 24→16 px，空出的 16 px 给频谱（y=40–56）；时间仍在歌手行右侧（12 px ASCII，`1:23` 约 28 px）。歌名 **22 px 常规体（不加粗）**方案由用户 2026-11-16 选定并实板确认（18 px bold 在 1bpp 下笔画粘连），备选「频谱 8 px + 歌名 24 px」暂不采用；样图见 `Music-Companion-Zily-Integration/preview/phase3-title/00-comparison.png`。**频谱刷新与暂停**：播放中约 8 Hz 只发频谱区（256 B / 2 片）；暂停时保持 OLED 上最后一帧不动（不发归零帧），恢复播放自动继续；无歌/未播放时频谱区保持空白。频谱形状为 24 根细竖条（柱宽 3 px、间隔 2 px，总宽 118 px，居中后两侧各留 5 px），条数常量在 29 号 `spectrumBars`，实板观感不合适时可改 32/20/16（柱宽按区域自动重算并居中）。

- 全屏首帧：`x=0,y=0,w=128,h=64,totalBytes=1024,totalChunks=5`，一次刷完整界面；之后只发变化区域。
- 长歌名：**>4 字滚动**（2026-11-16 用户要求，网页侧已实现，待实板复核）：128×24 窗口按 **6 px / 250 ms（约 24 px/s）** 左移，文字尾部离开后隔 32 px 接下一份，渲染器内部取模无缝循环；≤4 字保持静态居中。滚动只刷歌名区（384 B / 2 片），不碰歌手/时间/频谱/进度；同一时刻最多一次滚动更新在飞，显示忙时丢帧；切换歌曲时从第一屏重新开始。

## 8. 主机软件结构

新增 `web/js/29-oled-display.js`（Phase 1 只加这一个模块 + 面板入口；Phase 2 另加 30 号观察器；Phase 3 另加 31 号频谱同步；均不改 25/26/28）：

- `type`、`status`、`names`、`statusName`、`region`（定稿布局常量，含 Phase 3 的 `spectrum` 区）、`chunkBytes=240`、`maxBytes=1024`、`ackLength=3`、`spectrumBars=24`。
- `encodeBegin/encodeData/encodeEnd`：产出载荷（BEGIN 校验几何与 `totalBytes/totalChunks`，format 恒 0）。
- `validateAck(cmd)`：校验长度 3、CMD 回显、STATUS=OK；BAD_CHUNK 的错误消息带设备期望分片号，错误对象附 `.status` 供 END 重发判断；不 throw。`parseNextChunk(frame)` 读取 `NEXT_CHUNK`。
- `pack1bpp(imageData)`：RGBA 亮度阈值 128、按黑底 alpha 合成、行跨度 `ceil(width/8)`、MSB 在左。
- `create(bridge, { onLog, onBusyChange, renderer })`：
  - `showTestScreen()`：全屏静态测试屏（「玻璃 / Gareth.T / 1:23 / 50% 进度条」+ Phase 3 演示频谱）；
  - `updateRegion(x,y,w,h,bitmap)`、`updateSong(title,artist)`（title+artist 两区域）、`updateProgress(current,total)`（progress+artist 两区域，时间在歌手行右侧）、`updateSpectrum(levels)`（只发频谱区，等级 0–1 裁剪到 10 个）、`clear()`（全屏全 0）；
  - 内部串行队列：一次区域更新 = BEGIN → N×DATA → END 停等；分片失败用相同 session/chunk/offset 重发 1 次后放弃（保留旧画面）；END 遇 INTERNAL/IO_ERROR 重发 1 次；新更新覆盖尚未开始的旧更新，进行中的不中断；`onBusyChange` 回调保留（面板 Phase 3 起不再用它禁用按钮，改忙退避）；
  - 26 号单通道在忙时会拒绝请求，模块用 30 ms 退避重试（最多 10 次）而不是直接失败；
  - 默认 canvas 渲染器黑底白字：title 22px 常规（不加粗）中文居中（>4 字改窗口滚动）、artist 14px 左、时间 12px monospace 右对齐、频谱 24 柱底对齐、进度条 2 px 实心（上下各留 3 px）；Node 测试可注入 `renderer` 绕过 canvas。
- 每个分片使用现有 `bridge.request(type, 0x91, payload, validate)`；`26` 的单请求守卫天然保证停等。
- `27` 创建 bridge 时把 `typeNames` 合并为 `{...ZilyAppProtocol.names, ...ZilyOledDisplay.names}`；`index.html` 在 27 前加载 29/30/31；面板新增「测试 OLED」「暂停跟随/恢复跟随」按钮与状态行。Phase 3 起应用命令不再因 OLED 忙禁用：频谱约 8 Hz 占单通道近半时间，面板改为对 26 号「请等待当前请求结束」做 30 ms 退避（最多 20 次 ≈ 600 ms），命令自己等传输间隙。
- Phase 2：独立观察器（轮询播放器 DOM/公开状态，不改播放器核心）把歌名/歌手/进度推给 `updateSong/updateProgress`，已完成实板验收。
- Phase 3：新增 `web/js/31-oled-spectrum.js`，从 06 号的 `AnalyserNode` 采样，按对数频段映射成 24 柱推给 `updateSpectrum`；播放中约 8 Hz，暂停时保持 OLED 上最后一帧不动（不发归零帧），恢复播放继续，显示忙时整帧丢弃、不排队。
- 更新节流：歌名/歌手变化时发；进度 1 s 一次；频谱约 8 Hz（上限 8–10 Hz）；任何显示更新进行中时合并/丢弃后续更新，避免阻塞应用命令。

**Phase 2 实现现状（2026-11-16，已完成，实板验收通过）**

- 新增 `web/js/30-player-observer.js`（`ZilyPlayerObserver`）：只读播放器公开状态（`#songTitle`/`#songArtist` 文本 + `<audio id="audioEl">` 的 `paused/currentTime/duration`），不改播放器核心、不把串口逻辑塞进播放器/AI。
  - `create({ display, getSnapshot, isReady, onLog, onUpdate, pollIntervalMs=250, progressIntervalMs=1000, retryDelayMs=1000, now, setInterval })`：轮询周期 250 ms；歌名/歌手变化在下一周期内推 `updateSong`；进度每秒最多一次推 `updateProgress`；暂停后只推一次冻结画面，恢复播放立即再推一次；暂停中拖动导致整秒变化时补推（受单飞合并与链路限速）。
  - 更新合并：同一时刻最多一次显示更新在飞（单飞泵），期间读到的状态只保留最新快照，结束后按「歌名 → 进度」补齐；观察器自己不会产生第二个并发批次，因此 29 号的 `dropQueued()` 不会误丢未开始的更新。
  - 失败隔离：显示更新失败只记日志并在冷却 1 s 后重试同一状态；**歌名与进度的冷却各自独立**（进度失败不会推迟无关的切歌推送）；歌名失败时不紧接着推进度，避免旧歌手/旧时间上台；`getSnapshot` 异常或返回 null 时跳过本轮；所有异常不外抛，不影响播放/AI。`stop()` 会清定时器与待发标记，在飞更新结束后不再补发、也不再回报「已更新」。
  - `readPlayerSnapshot(doc)`：DOM 适配器，`duration` 非有限值或 ≤0 视为未知（`null`）；测试可注入假 document。
- `web/js/27-hardware-panel.js`：连接就绪（`phase==='ready'`）后自动启动观察器；断开或用户「暂停跟随」停止。Phase 2 用 `readyPhase`（仅看 phase）与 `serialReady`（含 26 号单通道忙）区分，避免 26 每个请求 `publish(busy=true)` 时把观察器反复 stop/start；Phase 3 起 `serialReady` 已移除，按钮改为忙退避。面板新增「暂停跟随/恢复跟随」按钮与跟随状态行（`跟随播放中 · 歌名 / 歌手 · m:ss / m:ss`）；点「测试 OLED」会先暂停跟随，让静态测试屏留在屏幕上（需手动点「恢复跟随」回到播放）；`onUpdate` 在非跟随状态一律忽略，避免观察器在飞回调把「正在发送测试屏…」回写成播放文案。
- `web/index.html`：OLED 小节标题改为「OLED 显示（跟随播放 + 实时频谱）」，脚本顺序 `28 → 29 → 30 → 31 → 33 → 27`；25/26/28 未改（25 号 SHA-256 仍为 `681D3BFF…D5C840`）。
- 离线测试：`test/player-observer.test.js` 21 个用例（快照适配、启动/停止、切歌、1 s 节流、暂停/恢复、暂停拖动、更新合并、失败重试、失败冷却按类型拆分、stop 后在飞不回报、快速 stop→start 重连、异常隔离、与真实 29 号模块的假 bridge 联调）；全量 `node --test` **416/416**（Phase 2 结束时）。
- 真实 Chrome 冒烟（假 Web Serial，一次性临时 CDP 脚本未落盘）：连接后自动显示「暂无播放」；模拟播放 →「玻璃 / Gareth.T · 0:00 / 3:20」；1 s 后 `0:01`；暂停后 1.2 s 内无新帧；恢复后继续；「测试 OLED」暂停跟随后静态屏保持；断开后观察器停止、状态回「未连接」。全程 0 个 JS 异常。
- 主线程开销（同一 Chrome 冒烟，6 s 跟随）：0 个 long task（>50 ms）、long task 累计 0 ms；一次「歌名+进度」完整 canvas 渲染 + 1bpp 打包 + 协议编码（假 ACK）≈0.52 ms，单次进度约 0.3 ms。真实串口耗时另计（约 100 ms/秒，见第 13 节第 3 条）。

**Phase 3 实现现状（2026-11-16，含长标题滚动补充）**

- 布局：歌名 24 / 歌手 16 / 频谱 16 / 进度 8（四区 0/24/40/56 全 8 像素对齐）；歌名 22 px 常规（不加粗）、歌手 14 px、时间 12 px monospace；频谱 24 柱、柱宽 3 px、间隔 2 px（24×3+23×2=118，居中后两侧各留 5 px）。
- 29 号：`region.spectrum`、`spectrumBars=24`、`updateSpectrum(levels)`（只发 128×16=256 B 频谱区，2 片）、canvas 渲染器新增 `renderSpectrum`/`drawSpectrum`；`showTestScreen` 含演示频谱；`updateSong/updateProgress` 改为新区域尺寸（title 384 B / artist 256 B / progress 128 B）。
- 新增 `web/js/31-oled-spectrum.js`（`ZilyOledSpectrum`）：`readAnalyserLevels(analyser, barCount)` 把 128 个 FFT bin 按 60 Hz–16 kHz 对数分段映射成 24 个 0–1 等级（gamma 0.75、复用 Uint8Array）；`create({display,getLevels,isPlaying,onLog,onUpdate,intervalMs=125,...})` 单飞推送：播放中约 8 Hz，显示 `isBusy()` 时丢帧，暂停时保持最后一帧不动（不发归零帧），失败日志按连续失败去重。
- 新增 `web/js/33-title-scroll.js`（`ZilyTitleScroll`，2026-11-16 用户要求 >4 字滚动）：按 6 px/250 ms 累加 offset 调 `display.updateTitle(title, offset)`，只刷歌名区；单飞、显示忙丢帧、标题变化从 0 重新开始；≤4 字不发、保持 29 号静态居中。29 号渲染器新增 `renderTitleWindow`（32 px 间隔、内部取模循环）。
- 27 号：连接就绪后观察器、频谱与标题滚动一起 start/stop；`getLevels` 只读 06 号的全局 `analyser`（不改音频链路）；应用命令/PING/ECHO 从「OLED 忙时禁用」改为 30 ms×20 次忙退避；「测试 OLED」先暂停跟随（含频谱）。
- `index.html`：脚本顺序 `28 → 29 → 30 → 31 → 33 → 27`；OLED 小节标题与提示更新为「跟随播放 + 实时频谱」。
- 离线测试：新增 `test/oled-spectrum.test.js` 11 个用例（频段映射/静音/gamma、启动停止、暂停冻结、忙丢帧、单飞、失败/采样异常隔离、与 29 号帧级联调）；`test/oled-display.test.js` 更新布局断言并新增 `updateSpectrum` 用例；观察器 21 个用例不变；另新增 `test/title-scroll.test.js` 8 个用例与 `updateTitle` 用例；全量 `node --test` **437/437**。
- 真实 Chrome 冒烟（假 Web Serial + 假 Analyser，一次性临时 CDP 脚本未落盘）：
  - 播放 2.2 s：频谱帧 24（约 8.2 Hz）、13 种不同位图、全部非零；同期进度帧 3（1 s 节奏）；
  - 暂停：只发 1 帧全零后停发（1 s 内帧数不变）；恢复后频谱继续；
  - 故意冻结显示 ACK 约 240 ms 制造单通道忙，期间点 3 次 PING 全部成功、0 条「请等待」错误，成功延迟约 268–303 ms（证明忙退避生效）；
  - 「测试 OLED」：全屏测试屏（含演示频谱）保持，恢复跟随后频谱重新出现；断开后全部停发；全程 0 个 JS 异常；
  - 长标题滚动：2.4 s 内歌名区 10 帧（约 4 Hz）、10 种不同位图、全部非空；改回短标题后仅 1 帧静态刷新、随后停发；0 JS 异常；
  - 主线程：0 个 long task；真实 canvas 渲染 + 1bpp 打包 + 协议编码成本：频谱 **0.07 ms/帧**、文字更新 **0.31–0.78 ms/次**（多次运行波动；假 ACK，不含串口 I/O）；
  - 带宽实测：稳定播放时约 **2.9–3.0 KB/s**（实测 2878–3021 B/s，取决于进度帧相位；约 26% 的 115200 8N1 上行），其中频谱 8 Hz × 约 315 B/帧 + 进度 1 Hz；I2C 侧约 2432 B/s（频谱 256 B×8 + 进度 384 B×1，约 20% 占空）。
- 上述数据的测量脚本与内部验收记录不随仓库发布；**实板验收已于 2026-11-16 由作者手动确认通过**（功能项、24 柱/5 px 留白、歌名 22 px 常规、歌手 14/时间 12 均确认）。

## 9. 固件结构与内存

新增 `firmware/App/zily_display_service.c/.h`：

- `uint8_t ZilyDisplayHandleCommand(uint8_t type, uint16_t seq, const uint8_t *payload, uint16_t len, ZilyUartSendFrame send)`：处理 `0x40–0x42` 与 `0x44–0x4F`，返回是否已处理；由 `zily_uart_protocol.c` 的 `DispatchFrame` 在应用命令分支之后、未知类型分支之前调用。
- 静态 `uint8_t displayBuffer[1024]`；会话状态 ~24 B；不动态分配。
- 发送 ACK 需要复用 `SendReply`：在 `zily_uart_protocol.h` 增加 `void ZilyUartProtocolSendReply(uint8_t type, uint16_t seq, const uint8_t *payload, uint16_t len, ZilyUartSendFrame send);`，内部仍调用原 `SendReply`；不影响现有行为。
- END 调 `ZILY_OLED_DrawBitmap(x,y,w,h,displayBuffer,totalBytes)`，检查返回值；再调 `ZILY_OLED_FlushRegion`，检查 `ZilyI2cStatus`。
- Watch：`zilyDisplayBeginCount`、`zilyDisplayDataCount`、`zilyDisplayEndCount`、`zilyDisplayErrorCount`、`zilyDisplayI2cErrorCount`、`zilyDisplayLastStatus`、`zilyDisplayBytes`。
- 所有权：OLED framebuffer 只由 UART 任务在运行期使用；启动自检在调度器前完成，不并发。

**实现现状（2026-11-16，Phase 1 已完成）**

- 文件：`firmware/App/zily_display_service.c/.h` 新增；`zily_uart_protocol.c/.h` 增加 `ZilyUartProtocolSendReply()` 与 `DispatchFrame` 里的显示类分支（应用命令分支之后、`switch` 之前）；`0x40–0x42`、`0x44–0x4F` 由显示服务处理，`0x43` 仍落到未知类型静默计数。
- 严格校验：DATA 的 `offset/len` 必须精确匹配固定分片；END 只接受 `flags=0x01`；数据不完整的 END 结束会话；`INTERNAL`/`IO_ERROR` 保留会话以便重发 END；重复的"上一片"重传直接 ACK，不重复拷贝。
- 计数语义：`zilyDisplayBeginCount`/`DataCount`/`EndCount` 统计收到的显示帧（含被拒帧），`ErrorCount` 统计非 OK ACK，`I2cErrorCount` 统计刷屏失败，`Bytes` 累计被接受的位图字节，`LastStatus` 为最近一次 STATUS。
- Watch 另外暴露 `zilyDisplaySessionActive`、`zilyDisplayNextChunk`，实板可直接看会话状态。

内存与构建（0-7A → 0-8A 实测）：

| 项 | 0-7A | 0-8A | 增量 |
|---|---:|---:|---:|
| Code | 15522 | 16426 | +904 |
| RO-data | 370 | 370 | 0 |
| RW-data | 368 | 412 | +44 |
| ZI-data | 8984 | 10004 | +1020 |
| 静态 SRAM 合计 | 9352 | 10416 | +1064 |

20 KB SRAM 扣掉静态区（10416 B）、四任务栈（最大 192 words × 4 ≈ 3 KB）和 MSP（1024 B）后约剩 5 KB，仍有余量。Keil Rebuild All：**0 Error(s), 0 Warning(s)**，产物 `Objects/0-8A/Zily-Hardware.axf`；`Listings/0-8A/Zily-Hardware.map` 已生成。

内存与构建的实测数据已并入上一节；下表是设计时的估算，保留作对照。

| 项 | 增量（估算） |
|---|---:|
| `displayBuffer[1024]` | +1024 B |
| 会话状态/计数 | ~32 B |
| 预计 0-8A ZI | ~10040 B（实测 10004 B） |
| 20 KB SRAM 余量（扣 MSP 1024 B） | 约 5 KB（实测口径见上） |

任务栈：UART 任务仍 192 words；`DrawBitmap + FlushRegion` 调用链会增加栈使用，0-8A 必须至少做一次 Keil Watch 栈高水位/堆余量记录（0-7A 跳过了 Watch，不能沿用旧值）。**该项已在 Phase 1 实板完成**（`zilyUartTaskStackHighWaterWords=0x74`、`zilyMinFreeHeapBytes=0x528`，见第 11 节）。

构建：0-8A 已把 `Objects/0-8A`、`Listings/0-8A` 同时配到 `.uvprojx` 和 `.uvoptx`（0-7A 的教训：只改 `.uvprojx` 会覆盖 0-6B listing），并确认 `Listings/0-8A` 内生成的是本阶段 map。

## 10. 兼容性

| 主机 | 固件 | 结果 |
|---|---|---|
| 旧 | 旧 | 现状：PING/ECHO、0-7A 应用命令正常 |
| 新 | 旧 | 显示请求被当未知 TYPE 静默丢弃 → 超时；PING/ECHO/应用命令不受影响 |
| 旧 | 新 | 旧主机不发显示命令；新固件保持 PING/ECHO/应用命令行为 |
| 新 | 新 | 全功能 |

新固件收到未知 `0x44–0x4F` 回 `UNSUPPORTED`；`0x43` 预留；`0x91` 若被主机误发，固件按未知类型静默计数，避免 ACK 环路。

## 11. 测试计划

**主机**
- 位图打包：16×8 已知图案、宽度非 8 倍数、MSB/行跨度、总长度。
- BEGIN/DATA/END 编码与示例帧逐字节一致。
- ACK 校验：OK、BAD_CHUNK、BAD_SESSION、IO_ERROR、CMD 回显、LEN。
- 重传：超时后同分片重发；重复 ACK；乱序 `NEXT_CHUNK`。
- 更新串行化/合并：新更新不打断旧更新的合法链路，最终发送最新内容。
- 文本渲染：非空、尺寸/stride 正确（字体相关不做像素金标）。
- 频谱（Phase 3）：Analyser 频段映射（静音全 0、满幅全 1、低频有能量时高频为 0、gamma 抬升）、等级裁剪/缺省补 0、暂停不再发帧（保留最后一帧）、显示忙丢帧、单飞合并、失败/采样异常隔离。

**固件离线（gcc + 显示后端 stub）**
- 单分片/多分片完整更新：ACK `NEXT_CHUNK` 递增，END 调 draw+flush 一次。
- 重复分片：不重复拷贝，ACK 原 `NEXT_CHUNK`。
- 乱序分片：`BAD_CHUNK` + 期望值。
- 无会话/会话不匹配：`BAD_SESSION`。
- 几何/长度/分片数/offset 非法：`BAD_PAYLOAD`。
- END 不完整：`BAD_PAYLOAD` 且不 draw/flush。
- draw 失败：`INTERNAL`；flush 失败：`IO_ERROR`；重发 END 可恢复。
- 新 BEGIN 覆盖旧会话；会话间缓冲边界不越界。
- PING/ECHO/0-7A 命令与显示帧交错，互不破坏。

**已执行（2026-11-16，Phase 1）**

- 固件离线：`firmware/tests/display_service_test.c`（13 组用例）+ 原有 `firmware/tests/uart_protocol_test.c`，gcc 严格告警编译（`-Wall -Wextra -Werror -Wconversion -pedantic -O2`）后运行，全部通过、exit 0；`0x40` 从"未知类型静默"用例中移除，改用 `0x43` 覆盖预留静默位。
- 协议文档第 14 节的 8 条示例帧做了双向核对：网页 `25-uart-protocol.js` 编码结果与文档逐字节一致；固件解析同样输入得到文档中的 ACK 帧（含 `NEXT_CHUNK`）。
- Keil Rebuild All：0 错误、0 警告；产物与 map 落在 `Objects/0-8A`、`Listings/0-8A`。
- 主机（网页）侧：`web/js/29-oled-display.js` + `test/oled-display.test.js` 20 个用例全绿；全量网页测试 **395/395**（原 375 + 新增 20），25 号 SHA-256 仍为 `681D3BFF…D5C840`（未改），26/28 未改。
- 最小 Watch（2026-11-16 实板，Keil Watch 1，点一次「测试 OLED」后 Stop 读取）：

| 符号 | 实测 | 判定 |
|---|---|---|
| `zilyDisplayLastStatus` | `0x00` | OK |
| `zilyDisplayEndCount` | `1` | 点一次 +1，符合预期 |
| `zilyDisplayErrorCount` | `0` | 无 NACK |
| `zilyUartTaskStackHighWaterWords` | `0x74` = **116 words 剩余** | 栈峰值 76/192 words（≈304 B），余量充足 |
| `zilyMinFreeHeapBytes` | `0x528` = **1320 B** | 堆健康 |

  注：第一次读数 `EndCount=0`、`StackHighWater=0` 是"本次上电没有串口流量"——UART 任务从未被唤醒时高水位采样不执行；补点一次测试屏后即得到上表数值。
- 跨语言端到端：用网页 `29 → 25` 生成的真实帧（全屏 5 片 + 16×8 区域 1 片，共 10 帧）喂给真实固件解析器与显示服务，10 条 ACK 与网页预期逐字节一致，两次 `DrawBitmap` 的位图与网页侧位图逐字节一致。证据与命令见 `Music-Companion-Zily-Integration/A4_OLED_PHASE1_REPORT.md`。

**已执行（2026-11-16，Phase 2 网页侧）**

- 新增 `test/player-observer.test.js` 21 个用例，`node --test test/player-observer.test.js` 21/21 通过；全量 `node --test` **416/416**（Phase 1 的 395 + 21）。
- 独立复核（peizi，只读取证）发现 2 个次要问题并已修正：① 失败冷却原本是全局门，进度失败会推迟无关的切歌最多 ~750 ms → 改为歌名/进度按类型各自冷却；② 暂停跟随后观察器在飞更新仍回调，可能把「正在发送测试屏…」回写成播放文案 → 面板 `onUpdate` 在非跟随状态忽略、观察器 stop 后不再回报「已更新」。回归新增 4 个用例，Chrome E2E 复跑通过（测试屏状态行序列只有「正在发送测试屏…」→「测试屏已发送」）。
- 25 号 SHA-256 仍为 `681D3BFF5D510907C68E6BF0027FDE7BA7FE744EA2095FFDD1B7A27DE0D5C840`；26/28 的修改时间与 Phase 1 一致（未改）。
- 真实 Chrome 冒烟（headless + CDP，假 Web Serial，一次性临时脚本未落盘）覆盖：连接后自动跟随（显示「暂无播放」）→ 模拟播放（玻璃 / Gareth.T / 0:00 / 3:20）→ 1 s 后进度 0:01 → 暂停后 1.2 s 内零新帧 → 恢复继续 → 「测试 OLED」自动暂停跟随、静态屏保持 → 「恢复跟随」重新同步 → 断开后观察器停止、状态回「未连接」；全程 0 个 JS 异常。
- 主线程开销（同一 Chrome 冒烟）：6 s 跟随期间 0 个 long task（>50 ms）、累计 0 ms；一次「歌名+进度」完整渲染+编码 ≈0.52 ms（假 ACK，不含真实串口 I/O）。
- 上述数据的测量脚本与内部验收记录不随仓库发布；**实板验收已于 2026-11-16 由作者手动确认通过**（功能项见下节「实板」；可选 Keil Watch 具体读数未单独留档）。

**已执行（2026-11-16，Phase 3 网页侧）**

- 新增 `test/oled-spectrum.test.js` 11 个用例，`node --test test/oled-spectrum.test.js` 11/11 通过；`test/oled-display.test.js` 更新为 Phase 3 布局并新增 `updateSpectrum`/`updateTitle` 用例（22/22）；`test/title-scroll.test.js` 8/8；全量 `node --test` **437/437**。
- 25 号 SHA-256 仍为 `681D3BFF5D510907C68E6BF0027FDE7BA7FE744EA2095FFDD1B7A27DE0D5C840`；26/28 修改时间与 Phase 1 一致（未改）；固件未改、无需重烧。
- 真实 Chrome 冒烟（headless + CDP，假 Web Serial + 假 Analyser，一次性临时脚本未落盘）：
  - 播放 2.2 s：频谱帧 24（约 8.2 Hz）、13 种不同位图、全部非零；同期进度帧 3（1 s 节奏）；
  - 暂停：只发 1 帧全零后停发（1 s 内帧数不变）；恢复后频谱继续；
  - 冻结显示 ACK 约 240 ms 制造单通道忙，期间点 3 次 PING 全部成功、0 条「请等待当前请求结束」，成功延迟约 268–303 ms（证明面板忙退避生效）；
  - 「测试 OLED」全屏（含演示频谱）保持，恢复跟随后频谱重新出现；断开后全部停发；全程 0 个 JS 异常；
  - 主线程 0 个 long task；渲染+编码成本：频谱 0.07 ms/帧、文字更新 0.31–0.78 ms/次（多次运行波动；假 ACK）；
  - 带宽实测约 2.9–3.0 KB/s（约 26% 的 115200 8N1），I2C 约 2432 B/s（约 20% 占空）。
- 上述数据的测量脚本与内部验收记录不随仓库发布；**实板验收已于 2026-11-16 由作者手动确认通过**（功能项、24 柱/5 px 留白、歌名 22 px 常规、歌手 14/时间 12 均确认）。

**实板**

- ✅ 静态测试屏：中文“玻璃 / Gareth.T + 1:23 + 50% 进度条”，整屏首帧（1024 B / 5 片）；用户确认中文清晰可读、四区位置正常（进度条已按观感细到 2 px）。Phase 3 起测试屏增加 24 柱演示频谱，布局改为「歌名 24 / 歌手 16 / 频谱 16 / 进度 8」；实板已确认 24 柱/5 px 留白观感；歌手/时间 14/12 px 与歌名 22 px 常规（不加粗）也已实板确认。
- ✅ Keil Watch（最小记录项）：`LastStatus=0x00`、`EndCount=1`、`ErrorCount=0`、`StackHighWater=116 words`、`MinFreeHeap=1320 B`（详见第 11 节"已执行"表）。
- ✅ 显示传输期间应用命令：连接串口后点「测试 OLED」，应用命令按钮为禁用态（设计如此），PING/ECHO 正常往返，显示链路不破坏 0-7A 行为。
- ✅ Phase 2 局部歌名/歌手/进度更新（2026-11-16 用户手动验收通过）：① 播放歌曲后 OLED 自动显示中文歌名/歌手/时间，进度条每秒推进；② 切歌后 250 ms 内歌名/歌手更新、时间复位；③ 暂停 → 进度/时间冻结、此后不再发帧，继续 → 恢复每秒更新；④ 播放中/暂停中拖动进度条，OLED 时间与进度跟随；⑤ 跟随期间 PING/ECHO 正常；应用命令按钮在每次显示传输期间短暂禁用（约每秒数百 ms）、间隙可用，命令成功；⑥ 播放与 AI 无卡顿；⑦ 日志出现「OLED 歌名/歌手已更新」；⑧ 拔插/复位后「恢复跟随」可重新同步；⑨「暂停跟随」后「测试 OLED」静态屏保持，「恢复跟随」回到播放。可选 Keil Watch（`zilyDisplayEndCount` 约每秒 +2 等）本次未单独留档读数。
- ✅ Phase 3 频谱（2026-11-16 用户手动验收通过；歌名 22 px 常规 + 歌手 14/时间 12 px 实板确认）：① 播放时频谱 24 柱实时跳动、无卡顿；② 暂停 → 频谱保持最后一帧不动，继续 → 恢复跳动；③ 切歌后频谱与歌名/时间同步更新；④ 频谱跳动期间 PING/ECHO/PAUSE/RESUME 均成功、延迟可接受；⑤ 24 柱/两侧 5 px 留白观感确认；⑥ 拔插/复位后恢复跟随可重新同步。后续实板反馈「歌手/时间不够清晰」→ 已调大 14/12 px；歌名 18 px bold 过粗 → 已改 22 px 常规体；以上均实板确认。Watch 读数未单独留档（可补）。
- ✅ 复位/拔插后重新连上，主机重发全屏首帧，屏幕恢复显示。
- ✅ 拔掉 OLED 后发显示更新：日志报 `IO_ERROR`，随后 PING/应用命令仍可用、不卡死 UART。

## 12. 分阶段实施

| 阶段 | 内容 | 验收 | 状态 |
|---|---|---|---|
| Phase 1 | 协议 + 固件 display service + 29 模块 + 面板“测试 OLED”按钮 | 静态中文屏在实板正确显示；PING/应用命令回归 | ✅ 已完成（含实板） |
| Phase 2 | 播放器观察器：歌名/歌手/进度自动更新（30 模块 + 面板自动跟随/暂停跟随） | 切歌/暂停/进度条跟随；不卡播放/AI | ✅ 已完成（离线 416/416、Chrome 假串口 E2E；实板 2026-11-16 用户确认通过） |
| Phase 3 | 实时频谱：歌名/歌手缩小让位，24 柱约 8 Hz（31 模块 + 面板联动）；长歌名 >4 字滚动（33 模块） | 频谱稳定跳动、暂停冻结、应用命令延迟可接受；长标题可读 | ✅ 已完成（离线 437/437、Chrome E2E；实板 2026-11-16 用户确认通过）；歌手/时间 14/12 px、歌名 22 px 常规已实板确认；长标题滚动待实板复核 |

Phase 1 的代码、离线验证、Keil 构建与实板全部验收项（测试屏、最小 Watch、显示期间应用命令、复位/拔插、拔 OLED 的 `IO_ERROR`）均已通过（2026-11-16）；Phase 2 的网页侧实现与实板验收（自动跟随、切歌、暂停/恢复、拖动进度、跟随期间应用命令、无卡顿、测试屏停留、断开重连）也已于当日完成；Phase 3（频谱）已完成实板验收；2026-11-16 歌手/时间调至 14/12 px、歌名改 22 px 常规（不加粗），实板确认通过。

**Phase 3 布局（2026-11-16 用户拍板：文字缩小 + 同屏频谱）**

- 定稿：歌名 24 / 歌手 16 / **频谱 16** / 进度 8；歌名 22 px 常规（不加粗）、歌手 14 px、时间 12 px；频谱 24 柱、柱宽 3 px、间隔 2 px（24×3+23×2=118，居中后两侧各留 5 px）。
- 放弃方案 A（整屏频谱 + 模式切换，不能同屏）与方案 C（8 px 窄带，柱高太低）；用户接受文字缩小，采用 B 的同屏四段思路。
- 协议不变，只是主机换渲染布局；频谱复用 `0x40/0x41/0x42`，区域 y=40–56、256 B、2 片。
- 柱数常量 `spectrumBars=24`，实板看观感后可直接改 20/24/12（柱宽自动重算并居中）。

## 13. 开放问题与决策（2026-11-16 已确认，冻结）

| # | 问题 | 决策 |
|---:|---|---|
| 1 | V1 是否包含频谱 | **最初不包含；2026-11-16 用户拍板改为 Phase 3 纳入**。布局采用「歌名 24 / 歌手 16 / 频谱 16 / 进度 8」，频谱 24 柱约 8 Hz；数据源为 `06-audio.js` 的 `AnalyserNode`；实测稳定带宽约 3.0 KB/s（约 26% UART），应用命令改用忙退避而不是禁用按钮。 |
| 2 | 长歌名截断还是滚动 | **2026-11-16 用户拍板改为滚动**：>4 字窗口滚动（6 px/250 ms、32 px 间隔、只刷歌名区）；≤4 字静态居中。网页侧已实现，待实板复核观感与带宽影响。 |
| 3 | +1024 B 缓冲与约 200 ms 阻塞 | **接受**。实测整屏 `FlushRegion` ≈94 ms（UART 任务忙等 I2C），加上 5 个 DATA 帧停等传输约 110 ms，全屏更新约 200 ms；静态 SRAM 10416 B，余量约 5 KB。副作用：26 号单通道在显示更新期间会拒绝应用命令。**Phase 3 修订**：频谱刷新频繁，面板不再禁用应用命令按钮，改为对「请等待当前请求结束」做 30 ms 退避（最多 ~600 ms），命令自动等传输间隙。 |
| 4 | 240 B 分片 + `0x91` ACK | **按方案执行**，并收严：`offset=chunk×240`、`len=min(240,totalBytes−offset)` 严格匹配；`END.flags` 只接受 `0x01`；`NEXT_CHUNK` 语义见 5.4。 |
| 5 | Phase 1 是否只做测试按钮 | **是**。Phase 1 = 协议 + 固件 display service + 29 模块 + 面板按钮 + 离线测试；播放器观察器留 Phase 2。 |
| 6 | 0-8A 是否做 Watch | **至少做一次最小 Watch**（全屏更新后读显示计数、`LastStatus`、UART 栈高水位、堆余量）。固件计数已内置，成本很低；**Phase 1 实板已完成**，读数见第 11 节。 |
| 7 | 底部 8 px 放时间是否够 | **底部 8 px 只放整宽进度条，时间移到歌手行右侧**（右对齐 `m:ss`）。8 px 只够 5×7 ASCII，`1:23/3:45` 会吃掉 42% 宽度。 |

## 14. 示例帧（已用 V1.0 CRC 复算）

示例：16×8 区域，1 个分片，session=7，x=0，y=56，w=16，h=8，位图 16 B。

| 场景 | 帧 |
|---|---|
| BEGIN，SEQ=1 | `A5 5A 01 40 01 00 09 00 07 00 38 10 08 00 10 00 01 44 C4` |
| ACK BEGIN，SEQ=1 | `A5 5A 01 91 01 00 03 00 40 00 00 A9 3F` |
| DATA，SEQ=2 | `A5 5A 01 41 02 00 14 00 07 00 00 00 FF FF 00 00 FF FF 00 00 FF FF 00 00 FF FF 00 00 9E 11` |
| ACK DATA，SEQ=2 | `A5 5A 01 91 02 00 03 00 41 00 01 3A C0` |
| END，SEQ=3 | `A5 5A 01 42 03 00 02 00 07 01 DC 61` |
| ACK END，SEQ=3 | `A5 5A 01 91 03 00 03 00 42 00 00 2A 31` |
| NACK 乱序分片 | `A5 5A 01 91 02 00 03 00 41 04 00 DF 1C` |
| NACK 会话不匹配 | `A5 5A 01 91 01 00 03 00 40 03 00 FA 6A` |

## 15. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-16 | 初版草案：BEGIN/DATA/END、240 B 分片、`0x91` ACK、1bpp 行优先、1024 B 缓冲、主机 29 模块、Phase 1–3。待新会话确认开放问题后实施。 |
| 2026-11-16 | 第 13 节 7 项开放问题确认并冻结（见新第 13 节决策表）。 |
| 2026-11-16 | Phase 1 实施：新增 `firmware/App/zily_display_service.c/.h`、`ZilyUartProtocolSendReply()` 与显示类分发、`firmware/tests/display_service_test.c`；网页新增 `web/js/29-oled-display.js` 与面板「测试 OLED」按钮；DATA 严格 offset/len、END 严格 flags、`0x43` 静默/`0x44–0x4F` 回 UNSUPPORTED；Keil 0-8A 构建 0 错误 0 警告（Code 16426 / RO 370 / RW 412 / ZI 10004）。实板验收与最小 Watch 已于当日完成，见第 11 节。 |
| 2026-11-16 | Phase 2 网页侧：新增 `web/js/30-player-observer.js`（`ZilyPlayerObserver`，250 ms 轮询、歌名即时、进度 1 s、单飞合并、歌名/进度分开的失败冷却）与 `test/player-observer.test.js` 21 用例；`27` 接线自动跟随/暂停跟随并区分 `readyPhase`/`serialReady`，`index.html` 脚本顺序 29→30→27；独立复核发现并修正 2 个次要问题（冷却全局门推迟切歌、测试屏状态行被在飞回调回写）；全量 416/416、真实 Chrome 假串口 E2E（复跑）与主线程开销冒烟通过；25/26/28 未改。 |
| 2026-11-16 | Phase 2 实板验收通过（用户手动确认）：连接自动跟随、播放显示歌名/歌手/时间、进度每秒推进、切歌、暂停冻结/恢复、播放中与暂停中拖动进度、跟随期间 PING/ECHO 与应用命令、播放/AI 无卡顿、测试屏停留与恢复跟随、断开重连重同步全部通过；可选 Keil Watch 读数未单独留档。 |
| 2026-11-16 | Phase 3 需求确认：用户要求 OLED 加实时跳动的条形频谱，歌名/歌手字号缩小让位；采用同屏布局 24/16/16/8、约 8 Hz；初版 10 柱观感太粗 → 二次反馈 16 柱 → 三次反馈 26 柱 → 四次反馈收进两侧留白：最终 24 柱（3 px + 2 px，两侧各 5 px）并把歌手行内边距对齐到 5 px；暂停时频谱保持最后一帧不归零。 |
| 2026-11-16 | Phase 3 网页侧实施：29 号更新布局/字号/`updateSpectrum`/`renderSpectrum`；新增 `31-oled-spectrum.js`（Analyser 对数频段映射、24 柱、暂停冻结、忙丢帧、单飞）与 `test/oled-spectrum.test.js` 11 用例；27 号联动观察器/频谱，应用命令从「忙时禁用」改为 30 ms 忙退避；脚本顺序 28→29→30→31→27；全量 428/428、真实 Chrome 假串口+假 Analyser E2E（频谱 8.2 Hz、13 种位图、暂停冻结、PING 忙退避、0 long task、约 2.9–3.0 KB/s）通过；25/26/28 未改，固件未改。实板频谱验收待用户执行。 |
| 2026-11-16 | Phase 3 实板验收通过（用户确认）：频谱 24 柱实时跳动、暂停冻结、切歌同步、频谱期间应用命令、测试屏停留、拔插重连均通过；24 柱/两侧 5 px 留白观感确认。 |
| 2026-11-16 | 实板反馈「歌手名/时间不够清晰」：歌手 12→14 px、时间 10→12 px（行高 16 px 不变，布局/协议/固件均不受影响）；歌名 18 px bold 过粗 → 22 px 常规（不加粗），均实板确认。 |
| 2026-11-16 | 长歌名滚动：29 号新增 `renderTitleWindow`/`updateTitle`，新增 `33-title-scroll.js`（>4 字按 6 px/250 ms 滚动，只刷歌名区；≤4 字静态居中），`27`/`index` 接线，`test/title-scroll.test.js` 8 用例；全量 437/437、Chrome E2E（长标题 2.4 s 内 10 帧/10 种位图，短标题停发）通过；待实板复核。 |
