# 0-9A 旋转编码器输入事件协议（编码器版）

本文定义 0-9A 阶段最终形态：**只保留旋转编码器**，STM32 把编码器旋转与按下动作作为无请求事件上报网页，网页执行播放器动作后再用 0-7A 应用命令回写 MCU 状态。底层帧完全沿用 [0-4C USART1 二进制协议 V1.0](0-4C-UART-Protocol.md)：SOF、VER、TYPE、SEQ、LEN、PAYLOAD、CRC16 均不改，`VER` 仍为 `0x01`。

> 2026-11-17 范围变更：用户确认**去掉 KEY1/KEY2 两个实体按键**（PB1/PB11 不再使用），只保留编码器。编码器按下改为：**单击 = 暂停/继续，快速按两下 = 下一首**；旋转 = 音量 ±5%/档。原「长按收藏」「按下静音」功能已移除。

## 1. 目标与范围

- 新增 `0xC0 KEY_EVENT`（仅编码器按下，keyId=3）与 `0xC1 ENCODER_EVENT` 两个 STM32 → PC 事件 TYPE，使用 `0xC0–0xEF` 预留事件段。
- 本阶段**不加事件 ACK**：`0x80–0x8F` 事件应答段保留不用。事件尽力而为，丢失不重传。
- 网页是播放控制的事实源；STM32 只上报原始输入，网页执行动作后用 0-7A `PAUSE`/`RESUME` 回写镜像状态（`NEXT` 不回写）。
- 不改 `web/js/25-uart-protocol.js`（SHA-256 仍为 `681D3BFF…D5C840`），不改 0-4C/0-7A/0-8A 已冻结帧语义。

## 2. 硬件接线（编码器，2026-11-17 用户确认）

| 功能 | 引脚 | 配置 |
|---|---|---|
| 编码器 A | PA6 | TIM3_CH1，编码器接口模式 |
| 编码器 B | PA7 | TIM3_CH2，编码器接口模式 |
| 编码器按下 | PA5 | 上拉输入，按下为低。**实测所用 5 针模块的 C 是公共地（COM），没有独立按键脚**：不要接 C，改用外接轻触按键（一脚 PA5、一脚 GND） |
| 编码器 VCC | 3.3 V | 模块供电（勿接 5V） |
| 编码器 GND | GND | 与开发板共地 |

- 编码器 A/B 使用 TIM3 编码器模式 3（TI1、TI2 双沿计数），输入滤波 `0xF`（fDTS/32、N=8），ARR=0xFFFF、PSC=0；机械抖动在硬件计数层被滤波。
- 按下脚 PA5 使用**内部上拉**，模块按下时把 PA5 接到 GND。
- **不再使用 PB1/PB11**（两个实体按键已从本阶段移除）。
- 实测 2026-11-17：所用 5 针编码器模块的 C 脚是**编码器公共地（COM，内部接地）**，不是按键输出；把 C 接 PA5 会让 PA5 恒为 0V。该模块没有独立 SW/KEY 脚，因此「按下」用**外接轻触按键**实现：一脚接 PA5、另一脚接 GND（或板子 GND），功能与文档一致（单击暂停/继续、双击下一首）。
- 实测该面包板 − 轨损坏/未通，编码器 VCC/GND 直接接板子 3V3/GND 后才正常工作；接线时先用万用表确认电源轨通断。
- 不占用：PB12（LED）、PA9/PA10（USART1）、PB8/PB9（I2C1 OLED）、PA0–PA3（TIM2 四路 LED PWM，0-6B 暂缓保留）。

## 3. TYPE 分配

| TYPE | 名称 | 方向 | LEN | 说明 |
|---:|---|---|---:|---|
| `0x01–0x04` | PING/PONG/ECHO/ECHO_REPLY | 双向 | — | 冻结，逐字节不变 |
| `0x10–0x13` | PAUSE/RESUME/NEXT/FAVORITE | PC → STM32 | — | 0-7A |
| `0x40–0x42` | OLED BEGIN/DATA/END | PC → STM32 | — | 0-8A |
| `0x80–0x8F` | 事件应答预留 | PC → STM32 | — | **本阶段不用** |
| `0x90` / `0x91` | APP_ACK / DISPLAY_ACK | STM32 → PC | — | 0-7A / 0-8A |
| `0xC0` | KEY_EVENT | STM32 → PC | 2 | `[keyId=3, action]` |
| `0xC1` | ENCODER_EVENT | STM32 → PC | 1 | `[int8 delta]` |
| `0xC2–0xEF` | 预留 | STM32 → PC | — | V1 不发送 |

设备若收到 `0xC0–0xEF`（主机不应发送）按未知 TYPE 静默处理，`unsupportedTypeCount++`，不回包。

## 4. 事件帧格式

| 偏移 | 字段 | 长度 | 说明 |
|---:|---|---:|---|
| 0 | SOF | 2 B | `A5 5A` |
| 2 | VER | 1 B | `01` |
| 3 | TYPE | 1 B | `C0` 或 `C1` |
| 4 | SEQ | 2 B | **恒为 0**（无应答关联） |
| 6 | LEN | 2 B | `C0`=2、`C1`=1 |
| 8 | PAYLOAD | LEN B | 见下 |
| 8+LEN | CRC16 | 2 B | 小端，覆盖 VER 至 PAYLOAD 末字节 |

CRC-16/CCITT-FALSE：`Poly=0x1021`、`Init=0xFFFF`、`RefIn=false`、`RefOut=false`、`XorOut=0x0000`。事件帧总长：KEY 12 B、ENCODER 11 B。

### 4.1 KEY_EVENT（`0xC0`，仅编码器按下）

| 字节 | 字段 | 取值 |
|---:|---|---|
| 0 | keyId | 恒为 `3`（编码器按下/PA5） |
| 1 | action | `0`=单击、`2`=双击；`1`=长按保留但**不产生** |

- **单击**：按下并松开，且在 280 ms 内没有第二次按下 → 网页执行「暂停/继续」（播放中暂停、暂停中继续），随后用 0-7A 回写 `PAUSE` 或 `RESUME`。
- **双击**：两次有效按下/松开，且两次「单击窗口」重叠（第二次按下发生在第一次松手后的 280 ms 内）→ 只发一个 action=2 事件，网页执行「下一首」；**不会**再额外发一次单击（所以快速按两下不会先暂停再切歌）。
- 没有长按动作；按住不放松开后仍按单击处理。
- 网页把 keyId≠3 或 action=1 的帧视为非法事件记录并丢弃。

### 4.2 ENCODER_EVENT（`0xC1`）

| 字节 | 字段 | 取值 |
|---:|---|---|
| 0 | delta | int8，编码器档位增量；正数 = 一个方向，负数 = 另一方向 |

- 4 个硬件计数 = 1 个机械档位；每次轮询把「计数差 / 4」作为档数发送，余数保留到下次，不丢零头。
- 一次轮询可能累计多档（快转），`delta` 绝对值最大 127；超过 ±127 会被钳制。
- `delta=0` 不发帧；`0x80`（-128）不会出现（固件钳制到 -127），网页按非法事件处理。
- 方向：默认正数 = 「往右转」→ 网页音量增大；如实物方向相反，把 `ZILY_INPUT_ENCODER_DIRECTION` 改为 `(-1)` 或对调 A/B。

## 5. 网页处理与状态回写

| 事件 | 网页动作 | 回写 MCU（0-7A） |
|---|---|---|
| 编码器单击（action=0） | `togglePlay()`：播放/暂停切换 | 动作后按 `<audio>.paused` 真实结果发 `RESUME` 或 `PAUSE`（约 150 ms 后） |
| 编码器双击（action=2） | `nextSong()` | 不回写（NEXT 非幂等） |
| 编码器旋转（`0xC1`） | `audio.volume ± 5%/档`，0–100% 钳制、四舍五入；旋转解除静音 | 无（音量不在 0-7A 状态位内） |

- 单击动作本身有约 280 ms 双击判定延迟；双击在第二次松开时立即执行。
- 回写复用面板按钮的 `bridge.request(CMD, 0x90, payload, validateAck)` 与 30 ms×20 次 busy 退避；连按时用单调代号只允许最新一次回写落地（旧 `PAUSE/RESUME` 丢弃），避免 MCU 镜像与页面相反。
- 回写是镜像同步，用于 OLED/后续灯效；网页播放器始终是事实源。
- 事件无 ACK，26 号在「有 pending 请求」时也会分发事件帧，但不拿事件帧满足/否决 pending 请求，也不覆盖 CRC/SEQ 校验行。

## 6. 固件实现

| 文件 | 作用 |
|---|---|
| `firmware/Drivers/KEY/zily_key.c/.h` | **仅 PA5**：编码器按下上拉输入；`ZILY_KEY_IsEncoderPushPressed()` |
| `firmware/Drivers/ENCODER/zily_encoder.c/.h` | TIM3 编码器接口；`ZILY_ENCODER_TakeDelta()` 读取并清零 16 位计数 |
| `firmware/App/zily_input_service.c/.h` | 纯逻辑：10 ms 时间门、对称 20 ms 防抖、280 ms 单击/双击窗口、4 计数/档、余数累积、发送失败计数；硬件与发送用注入 contract，主机可测 |
| `firmware/App/zily_uart_protocol.c/.h` | `ZilyUartProtocolSendEvent()`（仅 0xC0–0xEF、SEQ=0、复用静态 txFrame、返回成功/失败）与 `zilyUartEventFrameCount`、`zilyUartEventTypeErrorCount` |
| `firmware/App/zily_uart_service.c` | UART 任务每轮调用 `ZilyInputServicePoll(xTaskGetTickCount())`，事件用 `ZILY_USART1_SendData` 同步发出；不新增任务 |
| `firmware/App/main.c` | 启动时 `ZILY_KEY_Init()`、`ZILY_ENCODER_Init()` |
| Keil 工程 | 与 0-9A 初始版本相同（文件组/include/输出目录不变），输出 `Objects/0-9A`、`Listings/0-9A` |

### 6.1 采样与单击/双击时序

- UART 任务无 pending 帧时 10 ms 超时唤醒轮询输入；存在 pending 半帧时保持原 100 ms 空闲超时（不改变 0-4C 帧超时语义），此时输入采样最长可能被推迟到该 100 ms 超时结束。
- OLED 显示帧由 UART 任务同步刷 I2C，一帧约 50–60 ms；这段时间输入采样暂停。编码器计数由 TIM3 硬件累加，不受影响；编码器按下若整个动作落在 50–100 ms 阻塞内可能漏采（正常按压 >100 ms）。
- 按下/松开都做**对称** 2 采样（20 ms）防抖，释放抖动不会造成二次单击。
- 单击/双击判定：第一次松开后启动 280 ms 窗口；窗口内出现第二次有效按下 → 取消待发单击并武装双击，第二次松开时发 `action=2`；窗口到期仍无第二次按下 → 发 `action=0`。无长按。
- 编码器：4 计数=1 档，余数保留，一次最多 ±127 档。

### 6.2 事件发送

- `ZilyUartProtocolSendEvent()` 校验 TYPE 必须在 `0xC0–0xEF`、LEN ≤ 256、payload/send 非空；非法时 `zilyUartEventTypeErrorCount++` 并返回 0。
- 成功：`zilyUartEventFrameCount++`、`zilyUartTxFrameCount++`；失败：`zilyUartTxErrorCount++`、返回 0，输入服务 `zilyInputEventSendFailCount++`，**不重试**。
- 事件只从 UART 任务发送，复用与回复相同的静态 `txFrame`。

## 7. 内存、构建与产物

- Keil MDK 5.24a / ARMCC 5.06 update 5，Rebuild All：**0 Error(s), 0 Warning(s)**。
- 体积：`Code=17172`、`RO-data=388`、`RW-data=468`、`ZI-data=10004`；RAM `RW+ZI=10472 B`。
- 不新增任务、不新增动态分配；FreeRTOS heap 仍 5120 B。
- 产物：`firmware/Project/Objects/0-9A/Zily-Hardware.axf`、`firmware/Project/Listings/0-9A/Zily-Hardware.map`；日志 `firmware/Project/rebuild-0-9A.log`。
- 工程文件：`Zily-Hardware.uvprojx`（文件/include/输出目录）与 `Zily-Hardware.uvoptx`（ListingPath）已切 0-9A；原始备份 `*.bak-0-9A-before`。

## 8. 错误处理与 Watch 计数

| 场景 | 固件行为 | 网页行为 |
|---|---|---|
| 事件 TYPE 非法 | SendEvent 返回 0、TypeError++ | 不会收到 |
| TX 回调失败 | txError++、EventFrame 不增、返回 0 | 该事件丢失 |
| 收端收到 0xC0/0xC1 | 按未知 TYPE 静默、unsupportedTypeCount++ | — |
| 网页收到非法 keyId/action/长度/delta | — | 日志「非法」、丢弃、不影响后续动作 |
| 回写时串口忙（OLED 帧占用） | — | 30 ms 退避最多 20 次后放弃回写，仅记日志 |
| 回写 ACK 超时/NACK | — | 只记日志；播放器动作不回滚 |

Watch 变量（Keil）：

| 符号 | 含义 |
|---|---|
| `zilyInputPollCount` | 输入采样次数（10 ms 节拍） |
| `zilyInputKeyEventCount` | 成功上报的编码器按下事件数（单击+双击） |
| `zilyInputDoublePressCount` | 已上报的双击事件数（含发送失败） |
| `zilyInputEncoderEventCount` | 成功上报的编码器档位事件数 |
| `zilyInputEventSendFailCount` | 事件发送失败次数 |
| `zilyInputLastKeyId` / `zilyInputLastAction` | 最近一次成功按下事件（keyId=3；action 0/2） |
| `zilyInputLastEncoderSteps` | 最近一次成功编码器档数 |
| `zilyUartEventFrameCount` / `zilyUartEventTypeErrorCount` | 成功事件帧数 / 发送校验失败数 |
| `zilyUartTxFrameCount` / `zilyUartTxErrorCount` | 沿用，含事件帧 |
| `zilyUartTaskStackHighWaterWords` / `zilyMinFreeHeapBytes` | 栈高水位 / 堆最小余量 |

## 9. 示例帧（已用 V1.0 CRC 复算）

| 事件 | 帧 |
|---|---|
| 编码器单击（keyId=3，action=0），SEQ=0 | `A5 5A 01 C0 00 00 02 00 03 00 C3 B8` |
| 编码器双击（keyId=3，action=2） | `A5 5A 01 C0 00 00 02 00 03 02 81 98` |
| 编码器 +1 档 | `A5 5A 01 C1 00 00 01 00 01 2E 95` |
| 编码器 -1 档 | `A5 5A 01 C1 00 00 01 00 FF FF 9B` |
| 编码器 +3 档 | `A5 5A 01 C1 00 00 01 00 03 6C B5` |
| 编码器 -2 档 | `A5 5A 01 C1 00 00 01 00 FE DE 8B` |

## 10. 网页软件结构

| 文件 | 变更 |
|---|---|
| `web/js/26-web-serial.js` | `create()` 新增 `onEvent`；`0xC0–0xEF`：不写 CRC/SEQ 校验行、日志标「设备事件」、分发后 return，不参与 pending 请求 |
| `web/js/32-device-events.js` | `parse()`：keyId 仅 3、action 仅 0/2；`create({actions})`：单击→`playPause`、双击→`next`、旋转→`adjustVolume`；音量步进与校验 |
| `web/js/27-hardware-panel.js` | `deviceActions`：`playPause`（含 0-7A 回写与单调代号防乱序）、`next`、`adjustVolume`；面板「设备输入」状态行；无收藏/静音动作 |
| `web/index.html` | 「设备输入」提示改为编码器版；`32-device-events.js` 在 27 前加载 |
| `test/device-events.test.js` | 13 个用例：解析边界、单击/双击映射、异常隔离、音量步进、与真实 26 联调 |
| `test/web-serial.test.js` | 55 个用例（含 2 个 onEvent 用例） |

兼容性：

| 主机 | 固件 | 结果 |
|---|---|---|
| 旧网页 | 新固件 | 旧 26 把事件帧当未知帧记录后忽略，不崩、不影响请求 |
| 新网页 | 旧固件（三键版） | 旧固件发 keyId=1/2 的长按/短按事件；新网页按非法事件记录并忽略；单击/双击语义不同（旧固件不会发双击）→ 建议同时升级 |
| 新网页 | 新固件 | 全功能 |

## 11. 测试与实板验收

### 11.1 已执行的离线/浏览器测试（模型侧）

| 项 | 命令 | 结果 |
|---|---|---|
| 固件输入服务 | `gcc -std=c99 -Wall -Wextra -Werror -Wconversion -pedantic -O2 -Ifirmware/App firmware/tests/input_service_test.c firmware/App/zily_input_service.c` | 编译 0 警告；运行 exit 0（12 个场景：时间门/回绕、单击延迟窗口、双击抑制单击、两次单击间隔、单采样不确认、释放抖动、长按无动作、双击窗口回绕、编码器档位/余数/多档/钳位、发送失败、NULL 配置） |
| 固件协议 | 同 flags + `firmware/tests/uart_protocol_test.c`、`firmware/App/zily_uart_protocol.c`、`firmware/App/zily_app_state.c`、`firmware/App/zily_display_service.c` | 编译 0 警告；运行 exit 0（含 SendEvent 用例） |
| 固件显示回归 | `firmware/tests/display_service_test.c` 同 flags | exit 0，未回退 |
| Keil | Rebuild All 0-9A | **0 Error / 0 Warning**，体积见第 7 节 |
| 网页事件模块 | `node --test test/device-events.test.js` | 13/13 通过 |
| 网页串口 | `node --test test/web-serial.test.js` | 55/55 通过 |
| 网页全量 | `node --test` | **452/452 通过** |
| 浏览器 E2E | headless Chrome + 假 Web Serial + 假 `<audio>`，真实 26/27/28/29/30/31/32/33 | 7 幕全过、0 JS 异常、0 console.error |

E2E 里程碑（假串口注入事件；仅为联调证据，不等于实板）：

| 步骤 | 结果 |
|---|---|
| 编码器单击（初始暂停） | 开始播放；`RESUME（设备按键回写） · ACK OK` |
| 再单击 | 暂停；`PAUSE（设备按键回写） · ACK OK` |
| 双击 | 切到第二首（标题=测试二号、historyIdx 0→1） |
| 旋转 +3 / -2 档 | 音量 0.50 → 0.65 → 0.55 |
| PING 在途时旋转 | PING/PONG ACK OK，音量 0.50 → 0.55 |
| 连按两次单击 | 最后一帧回写 PAUSE，过期 RESUME 未落地（回写代号生效） |
| 非法事件（keyId=1、action=1、delta=0） | 日志记录并忽略，后续动作正常 |

### 11.2 实板验收（只能由用户手动执行）

1. 烧录 `firmware/Project/Objects/0-9A/Zily-Hardware.axf` 或同目录的 `Zily-Hardware.hex`（ST-Link SWD / STM32CubeProgrammer）。复位后确认 READY 文本、PB12 闪烁；默认构建屏幕为空白，连上网页并连接串口后才显示内容（开机图案自检见 `ZILY_BOOT_SELFTEST`）。
2. 接线只需编码器：A→**PA6**、B→**PA7**、C/SW→**PA5**、VCC→**3.3V**、GND→GND（PB1/PB11 不再使用）。
3. 用 Chrome 或 Edge 打开本机网页（默认 `http://127.0.0.1:8080/`，以 `.env` 的 `ZILY_PORT` 为准）→「电台设置 → 硬件调试」→ 连接设备管理器里 CH340 对应的串口（115200 8N1）。
4. **旋转编码器**：面板「设备输入」行显示音量百分比，每档 ±5%；往右应为音量增大，如相反改 `ZILY_INPUT_ENCODER_DIRECTION` 为 `(-1)` 后重新编译烧录。
5. **单击旋钮**：播放/暂停切换；约 280 ms 判定后执行，网页播放器状态变化，通信日志出现 `PAUSE/RESUME（设备按键回写）· ACK OK`。**事件帧本身没有 ACK**。
6. **快速按两下旋钮**（两次按下间隔 <280 ms）：下一首；日志出现 `编码器按下 双击 → 下一首`，**不应**同时出现暂停/继续动作。
7. 回归：面板 PING/ECHO/PAUSE/RESUME/NEXT/FAVORITE、测试 OLED、跟随播放与频谱（0-7A/0-8A）均应正常。
8. Watch 记录（运行后点几次）：`zilyInputPollCount` 持续增长；单击后 `zilyInputKeyEventCount`+1、`LastKeyId=3`、`LastAction=0`；双击后 `zilyInputDoublePressCount`+1、`LastAction=2`；旋转后 `zilyInputEncoderEventCount`+1/档；`zilyInputEventSendFailCount=0`、`zilyUartEventTypeErrorCount=0`、`zilyUartTaskStackHighWaterWords`/`zilyMinFreeHeapBytes` 正常。

判定：旋转/单击/双击在网页端稳定生效、OLED 与 0-7A 状态同步、0-8A 显示无回退；失败时记录「现象 + 串口日志 + Watch 值」。

**实板验收结果（2026-11-17 用户手动确认，编码器版）**：

| 验收项 | 结果 |
|---|---|
| 旋转调音量（方向/每档 5%） | ✅ 通过 |
| 外接按键单击暂停 / 继续 | ✅ 通过 |
| 快速双击下一首（<280 ms，不先暂停） | ✅ 通过 |
| PING/ECHO/0-7A/0-8A 既有功能回归 | ✅ 通过（用户确认功能没问题） |

硬件实测补充：所用 5 针模块 **C=公共地（COM），不能接 PA5**；模块无 SW/KEY 脚，「按下」用外接轻触按键（A5–GND）；面包板 − 轨损坏，编码器 VCC/GND 需直连板子 3V3/GND。

## 12. 未解决问题与已知限制

1. **实板已验收通过**（编码器版，2026-11-17 用户手动确认）：方向、4 计数/档、280 ms 单击窗口与双击手感均正常；整体联调如发现问题再调参。
2. 单击动作有约 280 ms 双击判定延迟；双击在第二次松开时执行。若用户希望单击零延迟，可改成「单击立即执行 + 双击回退」，但会造成双击先暂停再切歌，不推荐。
3. 事件无 ACK、不重传；UART 任务被 OLED 帧阻塞 50–100 ms 期间事件会延迟，极短按压可能漏采（编码器计数不受影响）。
4. 回写 MCU 状态有约 150 ms 延迟，只影响 OLED 镜像，不影响播放动作。
5. 网页无独立音量 UI，音量只能从面板「设备输入」行或通信日志看到。
6. `0x80–0x8F` 事件应答段仍未使用；若以后需要可靠事件再引入 ACK/去重。
7. 0-8A「长标题滚动」由另一会话并行实施（`33-title-scroll.js`、`29`、`27`、`index.html`），与 0-9A 合并后互不改变对方逻辑；实板验收应同时确认不互相干扰。
8. 编码器版为 2026-11-17 范围变更后的最终形态；此前针对三键版的独立复核（peizi-review-2/3）结论中，与收藏/静音相关的部分已随功能移除失效，回写代号串行化仍保留；编码器版的二次复核待补。

## 13. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-16 | 初版：KEY1/KEY2/编码器按下 + 单击/长按/旋转，事件 0xC0/0xC1。 |
| 2026-11-17 | 范围变更：去掉 KEY1/KEY2 与长按收藏、按下静音；编码器按下改为单击=暂停/继续、双击=下一首；新增 280 ms 双击窗口、`action=2`、`zilyInputDoublePressCount`；固件/网页/测试/文档同步。 |