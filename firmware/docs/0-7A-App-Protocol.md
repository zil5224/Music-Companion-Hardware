# 0-7A 应用层指令协议（帧 V1.0 不变）

本文定义应用层命令、应答与错误处理。底层帧完全沿用 [0-4C USART1 二进制协议 V1.0](0-4C-UART-Protocol.md)：SOF、VER、TYPE、SEQ、LEN、PAYLOAD、CRC16 均不改，`VER` 仍为 `0x01`。

## 1. 范围与结论

- `0x01–0x04` 已被 PING/PONG/ECHO/ECHO_REPLY 占用并实板验证，**永久冻结**，任何应用层语义都不得复用。
- 应用层命令使用 `0x10–0x3F`，应答使用 `0x90`。旧文档里的「`0x01` 暂停 / `0x02` 继续 / `0x03` 下一首 / `0x04` 收藏」作废，代码与文档统一为 `0x10–0x13`。
- 本阶段方向为 **PC 网页 → STM32 状态同步**。STM32 只更新本地应用状态并 ACK，不控制网页播放器。MCU → 网页的按键事件留给后续实体按键阶段（`0xC0–0xEF` 事件段 + `0x80–0x8F` 事件应答段）。

## 2. 帧格式

| 偏移 | 字段 | 长度 | 说明 |
|---:|---|---:|---|
| 0 | SOF | 2 B | `A5 5A` |
| 2 | VER | 1 B | `01` |
| 3 | TYPE | 1 B | 见第 3 节 |
| 4 | SEQ | 2 B | 小端，请求/应答关联 |
| 6 | LEN | 2 B | 小端，0–256 |
| 8 | PAYLOAD | LEN B | 二进制数据 |
| 8+LEN | CRC16 | 2 B | 小端，覆盖 VER 至 PAYLOAD 末字节 |

总长 `10 + LEN`。CRC-16/CCITT-FALSE：`Poly=0x1021`、`Init=0xFFFF`、`RefIn=false`、`RefOut=false`、`XorOut=0x0000`。SEQ 只用于匹配请求与应答，0 合法。

## 3. TYPE 分配总表

| 段 | 方向 | 用途 | 本阶段行为 |
|---|---|---|---|
| `0x00` | — | 保留/非法 | 静默，`unsupportedTypeCount++` |
| `0x01–0x04` | 双向 | 链路控制（PING/PONG/ECHO/ECHO_REPLY） | **冻结，逐字节不变** |
| `0x05–0x0F` | — | 链路层预留（能力查询/复位/波特率等） | 静默，`unsupportedTypeCount++` |
| `0x10–0x3F` | PC → STM32 | 应用命令 | 见第 4 节；未实现类型回 `UNSUPPORTED` |
| `0x40–0x7F` | PC → STM32 | 批量数据预留（OLED 位图/频谱） | 静默，`unsupportedTypeCount++` |
| `0x80–0x8F` | PC → STM32 | 事件应答预留（按键阶段） | 静默，`unsupportedTypeCount++` |
| `0x90–0xBF` | STM32 → PC | 命令应答；`0x90` = APP_ACK | 见第 5 节 |
| `0xC0–0xEF` | STM32 → PC | 设备事件预留（按键/旋钮/状态） | 静默，`unsupportedTypeCount++` |
| `0xF0–0xFF` | — | 调试/私有，不进生产 | 静默，`unsupportedTypeCount++` |

设备收到 `0x90`（主机不应发送）按未知类型静默计数，不回应答，避免 ACK 环路。

## 4. 应用命令

| TYPE | 名称 | 方向 | LEN | PAYLOAD | 执行 |
|---|---|---|---|---|---|
| `0x10` | PAUSE | PC → STM32 | 0 | 空 | `playing=0` |
| `0x11` | RESUME | PC → STM32 | 0 | 空 | `playing=1` |
| `0x12` | NEXT | PC → STM32 | 0 | 空 | `nextCount++` |
| `0x13` | FAVORITE | PC → STM32 | 1 | `00` 未收藏 / `01` 已收藏 | `favorited=payload[0]` |
| `0x14` | STATE_QUERY | — | — | — | **预留，本阶段不实现**（收到回 `UNSUPPORTED`） |
| `0x15–0x3F` | — | — | — | — | 预留，收到回 `UNSUPPORTED` |

载荷规则：

- `0x10/0x11/0x12`：`LEN` 必须为 0；否则不执行，回 `BAD_PAYLOAD`。
- `0x13`：`LEN` 必须为 1，值只能是 `0x00/0x01`；否则不执行，回 `BAD_PAYLOAD`。
- `0x14–0x3F`：回 `UNSUPPORTED`，不执行。
- 命令载荷全部为小端字节流；本阶段无多字节参数。

语义说明：这四个命令是**状态同步通知**，不是播放控制。网页端是播放事实源，STM32 只是镜像状态，为后续 OLED/灯效提供数据。PAUSE/RESUME/FAVORITE 幂等；NEXT 非幂等（重复发送会多次 `nextCount++`）。

## 5. APP_ACK（`0x90`）

| 字节 | 字段 | 说明 |
|---:|---|---|
| 0 | CMD | 回显请求 TYPE（`0x10–0x3F`） |
| 1 | STATUS | 执行结果 |
| 2 | STATE | 应答时刻的设备状态快照（位域） |

`LEN=3`。主机接受 `LEN` 3–8 并忽略多余字节，小于 3 视为协议错误。

### 5.1 STATUS

| 值 | 名称 | 含义 |
|---:|---|---|
| `0x00` | OK | 已执行，状态已更新 |
| `0x01` | UNSUPPORTED | 命令段内 TYPE 未实现，未执行 |
| `0x02` | BAD_PAYLOAD | 载荷不符合该命令规则，未执行 |
| `0x03` | BAD_STATE | 当前状态不允许（V1 预留，镜像模型下不产生） |
| `0x04` | BUSY | 暂时无法处理（V1 预留） |
| `0x05` | INTERNAL | 内部错误 |
| `0x06–0xFF` | — | 预留；主机按失败处理 |

每个合法命令帧**恰好回一个** APP_ACK，在 `DispatchFrame` 上下文同步构建并发送；不得延迟到其它任务发送（静态 `txFrame` 只能由 UART 任务独占）。

### 5.2 STATE 位

| 位 | 名称 | 含义 |
|---:|---|---|
| bit0 | PLAYING | 1 播放中，0 已暂停 |
| bit1 | FAVORITED | 1 已收藏，0 未收藏 |
| bit2–7 | — | 必须为 0，主机忽略 |

**语义**：`STATE` 恒等于应答时刻设备侧的真实状态；NACK 时表示“未变更后的当前状态”，不代表命令生效。主机只在 `STATUS=0x00` 时更新镜像，且只更新该命令影响的状态位：

- PAUSE → 更新 `playing=false`；
- RESUME → 更新 `playing=true`；
- FAVORITE → 更新 `favorited`；
- NEXT → 不更新镜像（不携带状态变化）；
- NACK → 不更新镜像。

设备复位后应用状态回到默认值（`playing=0`、`favorited=0`），主机镜像可能陈旧。V1 不做自动状态查询：任何后续 `STATUS=0x00` 的 PAUSE/RESUME/FAVORITE 都会带回真实状态并自愈；面板在重连/新 generation 时把镜像标记为“未知”。`0x14 STATE_QUERY` 预留，后续需要主动对账时再实现。

## 6. 错误处理

| 场景 | 固件行为 | 主机表现 |
|---|---|---|
| VER/CRC/LEN 非法 | 静默，错误计数 +1 | 1000 ms 超时 |
| 命令段 TYPE 未实现（`0x14–0x3F`） | 回 `UNSUPPORTED`，`unsupportedTypeCount++`、`appNackCount++` | 报“设备不支持该命令” |
| 命令载荷非法 | 回 `BAD_PAYLOAD`，不执行，`appNackCount++` | 报“载荷不符合协议” |
| `0x00/0x05–0x0F/0x40–0xFF` | 静默，`unsupportedTypeCount++` | 超时 |
| 发送回调失败 | `txErrorCount++`，线上可能无 ACK | 超时 |
| ACK SEQ 不匹配 | — | 记日志，继续等待 |
| ACK CMD 回显不匹配 / LEN<3 / 未知 STATUS | — | 立即判协议错误 |
| 重复 ACK | 一帧一 ACK | 首个生效，后续无 pending 时忽略 |

计数语义（Keil Watch）：

| 计数器 | 增加时机 |
|---|---|
| `zilyUartValidFrameCount` | CRC/LEN 合法（含命令、NACK、未知类型） |
| `zilyUartUnsupportedTypeCount` | TYPE 无处理器：`0x00`、`0x05–0x0F`、`0x14–0x3F`（回 NACK）、`0x40–0xFF`、设备收到的 `0x90` |
| `zilyUartAppCommandCount` | `0x10–0x3F` 且 CRC/LEN 合法（含载荷非法、未实现类型） |
| `zilyUartAppNackCount` | 向命令段回复 `STATUS≠0x00` |
| `zilyUartTxFrameCount` / `zilyUartTxErrorCount` | 发送成功/失败（沿用） |
| `zilyAppPlaying` / `zilyAppFavorited` / `zilyAppNextCount` | 应用状态机 |

## 7. 时序、超时与重试

```
主机                          STM32
 |  PAUSE, SEQ=5, LEN=0        |
 |--------------------------->|
 |                            | 校验 → playing=0
 |  APP_ACK, SEQ=5, [10,00,00]|
 |<---------------------------|
 | 校验 SEQ/CMD/STATUS/STATE  |
 | 更新镜像 → 面板“已暂停”    |
```

- 单请求在途：主机发命令前必须没有未完成请求（沿用现有 `pending/writing` 守卫）。
- 超时 1000 ms。超时只 reject 命令，**不断串口、不自动重连**。
- **不自动重试**。`PAUSE/RESUME/FAVORITE` 幂等，用户手动重试安全；`NEXT` 非幂等，超时后重试可能多切一次，面板文案需提示“结果未知”。
- 不做 `(SEQ,TYPE)` 去重缓存。将来若引入自动重试，先加去重缓存再开重试。
- 主机对重复/迟到 ACK 的防护：匹配 pending SEQ 的首个 ACK 生效，其余忽略；超时后旧 ACK 只记日志。

## 8. 示例帧

| 场景 | 帧 |
|---|---|
| PAUSE，SEQ=5 | `A5 5A 01 10 05 00 00 00 AF F3` |
| ACK OK（暂停后，STATE=0） | `A5 5A 01 90 05 00 03 00 10 00 00 72 E7` |
| RESUME，SEQ=6 | `A5 5A 01 11 06 00 00 00 22 C2` |
| ACK OK（播放中，STATE=1） | `A5 5A 01 90 06 00 03 00 11 00 01 E1 18` |
| NEXT，SEQ=7 | `A5 5A 01 12 07 00 00 00 44 5A` |
| ACK OK（STATE=1） | `A5 5A 01 90 07 00 03 00 12 00 01 D0 F9` |
| FAVORITE=1，SEQ=8 | `A5 5A 01 13 08 00 01 00 01 F7 B8` |
| ACK OK（播放+已收藏，STATE=3） | `A5 5A 01 90 08 00 03 00 13 00 03 4B 64` |
| PAUSE 带 1 B 载荷（非法） | `A5 5A 01 10 0A 00 01 00 00 B5 22` |
| NACK BAD_PAYLOAD（STATE=1） | `A5 5A 01 90 0A 00 03 00 10 02 01 D8 1B` |
| 未实现 TYPE `0x14` | `A5 5A 01 14 0C 00 00 00 DE 89` |
| NACK UNSUPPORTED（STATE=1） | `A5 5A 01 90 0C 00 03 00 14 01 01 6E 33` |

所有向量已用帧 V1.0 的 CRC-16/CCITT-FALSE 复算，并与 0-4C 文档的 PING/PONG/ECHO 向量交叉验证。

## 9. 兼容性

| 主机 | 固件 | 结果 |
|---|---|---|
| 旧 | 旧 | PING/ECHO 正常（现状） |
| 新 | 旧 | PING/ECHO 正常；应用命令被旧固件静默丢弃 → 1000 ms 超时；串口保持 |
| 旧 | 新 | PING/ECHO 逐字节不变；旧主机不发应用命令 |
| 新 | 新 | 全功能 |

收到 `UNSUPPORTED` NACK 可证明固件已支持 0-7A；纯超时无法区分旧固件与链路故障。实板验证应用命令前必须先烧录 0-7A 固件。

## 10. 实现落点

- 固件：`firmware/App/zily_uart_protocol.c/.h` 增加命令分发与 ACK；新增 `firmware/App/zily_app_state.c/.h`；Keil App 组加入新文件；离线测试 `firmware/tests/uart_protocol_test.c`。
- 网页：`web/js/25-uart-protocol.js` **不改**；`web/js/26-web-serial.js` 增加通用 `request` 校验；新增 `web/js/28-app-protocol.js`；`web/js/27-hardware-panel.js` 与 `web/index.html` 加命令按钮和状态显示；测试 `test/app-protocol.test.js`、`test/web-serial.test.js`。
- 状态归属：V1 应用状态由 UART 任务独占（Keil Watch 读取）。后续 OLED 阶段跨任务访问时使用临界区或消息传递，不直接共享可变全局。

## 11. 测试与实板验收

离线：

- 固件：`gcc -std=c99 -Wall -Wextra -Werror -Wconversion -pedantic -O2 -Ifirmware/App firmware/tests/uart_protocol_test.c firmware/App/zily_uart_protocol.c firmware/App/zily_app_state.c -o <临时 exe>`。
- 网页：`node --test test/app-protocol.test.js test/web-serial.test.js`，再跑全量 `node --test`。
- Keil Rebuild All：0 错误、0 警告。

实板（需人工烧录与操作）：

1. 烧录 0-7A 镜像，确认 READY 文本、PB12 闪烁、OLED 自检。
2. PING/PONG、ECHO 6 B、ECHO 256 B 回归。
3. 面板四个命令：ACK 上屏、STATE 显示正确、连点被 busy 守卫。
4. FAVORITE=2 非法载荷 → NACK；随后合法命令 OK 且状态位正确。
5. 未实现 `0x14` → UNSUPPORTED NACK。
6. 命令中拔插/复位 → 1000 ms 超时、串口不自动重连、恢复后首条命令成功。
7. PAUSE+RESUME 拼帧一次发送 → 两个 ACK 顺序正确。
8. 记录 `zilyUartTaskStackHighWaterWords`（基线 162 words）与堆余量（基线 1320 B）。

## 12. 预留与未决

- `0x14 STATE_QUERY`：预留，未实现。
- `0xC0–0xEF` 设备事件 + `0x80–0x8F` 事件应答：实体按键阶段实现。
- 旧固件识别：靠 `UNSUPPORTED` NACK；纯超时不可区分。
- `NEXT` 幂等性：非幂等，自动重试前必须先做去重。
- 应用状态跨任务访问：OLED 阶段再定同步方式。

## 13. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-11-15 | 初版：冻结 `0x01–0x04`，应用层 `0x10–0x13`，ACK `0x90`；合并独立复核的 P1 规格（0x05–0x0F 静默、计数语义、NACK STATE、复位失同步、日志名回退）。 |