# Zily-Hardware 0-4C USART1 二进制协议 V1.0

> 本文件定义的 `TYPE 0x01–0x04` 永久冻结。应用层指令、`APP_ACK` 与 TYPE 分配总表见 [0-7A 应用层指令协议](0-7A-App-Protocol.md)；帧布局、VER、CRC 规则仍以本文件为准。

## 帧格式

USART1 使用 PA9 TX、PA10 RX，115200 baud、8N1，无流控。复位时先发送一次 ASCII `ZILY UART1 READY\r\n`，之后由 UART 服务任务接收和回复二进制帧。

| 偏移 | 字段 | 长度 | 值 |
|---:|---|---:|---|
| 0 | SOF | 2 B | `A5 5A` |
| 2 | VER | 1 B | `01` |
| 3 | TYPE | 1 B | 命令类型 |
| 4 | SEQ | 2 B | 请求和回复关联序号 |
| 6 | LEN | 2 B | Payload 字节数，范围 0–256 |
| 8 | PAYLOAD | LEN B | 二进制数据，允许任意字节 |
| 8 + LEN | CRC16 | 2 B | 从 VER 到 Payload 末字节的 CRC |

总长为 `10 + LEN` B，最大 266 B。SEQ、LEN 和 CRC16 低字节先传。固件逐字节读写字段。CRC-16/CCITT-FALSE 使用 `Poly=0x1021`、`Init=0xFFFF`、`RefIn=false`、`RefOut=false`、`XorOut=0x0000`。当 Payload 为空时，计算范围为 VER、TYPE、SEQ、LEN 共 6 B。标准向量 ASCII `123456789` 的结果是 `0x29B1`。

## 命令与实测主机向量

| TYPE | 命令 | 方向 | Payload |
|---|---|---|---|
| `01` | PING | PC → STM32 | 空 |
| `02` | PONG | STM32 → PC | 空，沿用请求 SEQ |
| `03` | ECHO | PC → STM32 | 0–256 B |
| `04` | ECHO_REPLY | STM32 → PC | 沿用请求 SEQ、LEN 和全部 Payload 字节 |

回复重新计算 CRC。收到 PONG、ECHO_REPLY 或未知 TYPE 时保持静默，未知 TYPE 另行计数。SEQ 只用于匹配请求与回复。PING 和 PONG 携带 Payload 时计为格式错误并丢弃整帧。

| 帧 | HEX 字节 |
|---|---|
| PING，SEQ 1 | `A5 5A 01 01 01 00 00 00 55 97` |
| PONG，SEQ 1 | `A5 5A 01 02 01 00 00 00 87 79` |
| ECHO `ABC`，SEQ 2 | `A5 5A 01 03 02 00 03 00 41 42 43 81 8C` |
| ECHO_REPLY `ABC`，SEQ 2 | `A5 5A 01 04 02 00 03 00 41 42 43 99 4B` |

## 解析、同步与 FreeRTOS

解析器按首字节、完整 SOF、VER、定长头、整帧五个长度检查点推进。它保留跨通知的候选数据。候选帧通过 CRC 后按其完整长度消费，所以合法 Payload 中的 `A5 5A` 或完整内嵌帧都属于 Payload。VER 错误、LEN 超限或 CRC 失败时，解析器从失败候选的第二字节迭代扫描，尝试恢复缓冲区中已经收到的后续帧。若仍有未完成候选，任务在排空后最多等待 100 个 1 ms tick 的新通知。等候超时会结束当前候选，并扫描已缓存的完整后续帧。扫描和内存移动都局限于 266 B 的候选缓冲区。

USART1 ISR 沿用 SR/DR 读取、512 B RX 环和原任务通知位。收到硬件错误或环满丢字节时，ISR 记下最新断点的 `rxHead`。任务每轮先读队头快照，再检查断点。只有在快照前未发生丢失时才取该快照中的字节。若读完快照后才发生丢失，当前快照最多提供一个断点前的字节。任务在取下一个字节之前再次检查断点。发现断点时，任务在能屏蔽优先级 5 USART IRQ 的短临界区内，将读指针推进到最新断点并确认该事件，随后复位解析器。这样会丢弃断点前尚未消费的积压，保留断点之后已入环的字节。一个重置可合并多次连续丢失，ISR 的错误和溢出计数分别记录每次事件。

`UART_ServiceTask` 优先级 3，栈 192 words。只有该任务运行协议解析并通过同步回调调用 `ZILY_USART1_SendData(const uint8_t *, uint16_t)`。RX IRQ 在轮询发送期间继续入环。驱动每次等 TXE 或 TC 最多读状态寄存器 10000 次。返回 1 表示整帧发送完成，返回 0 计入发送失败，线上可能只留下部分帧。建议主机收到回复或等到超时后再发下一条请求，特别是最大长度 ECHO。

## 诊断与构建

| Keil Watch 变量 | 含义 |
|---|---|
| `zilyUartValidFrameCount` | 帧通过版本、长度、CRC 和已知类型的载荷约束，包含未知类型和收到的响应帧 |
| `zilyUartCrcErrorCount` | 长度范围内的候选帧 CRC 不匹配 |
| `zilyUartFrameFormatErrorCount` | VER 非法或 PING/PONG 携带 Payload |
| `zilyUartFrameLengthErrorCount` | 帧头声明 LEN 大于 256 |
| `zilyUartUnsupportedTypeCount` | 校验通过但 TYPE 未定义 |
| `zilyUartPingCount`、`zilyUartEchoCount` | 接受的 PING、ECHO 请求数 |
| `zilyUartTxFrameCount`、`zilyUartTxErrorCount` | 发送回调成功、失败次数 |
| `zilyUartProtocolResetCount`、`zilyUartFrameTimeoutCount` | 因 RX 断点重置、因通知等候超时结束候选的次数 |
| `zilyUartRxIsrByteCount`、`zilyUartRxEnqueuedByteCount`、`zilyUartRxTaskByteCount` | RXNE 字节、入环字节、任务实际取出的字节。断点前被批量丢弃的积压会使任务计数低于入环计数 |
| `zilyUartRxOverflowCount`、`zilyUartRxErrorCount`、`zilyUartRxOverrunCount`、`zilyUartRxEventFlags` | 环满、USART 错误、ORE 和已观察到的粘滞事件位 |
| `zilyUartTaskStackHighWaterWords`、`zilyUartServiceFreeHeapBytes` | UART 任务历史最少剩余栈字数、最近采样的 FreeRTOS 堆余量 |

Keil Rebuild All 使用 ARMCC 5.06 update 5 build 528，0 错误、0 警告。Flash 实际装载 13212 B，SRAM 8280 B，相比 0-4B 分别增加 796 B、584 B。原 512 B RX 环之外新增两个 266 B 静态帧缓冲。FreeRTOS `ucHeap` 为 5120 B，任务与队列沿用现有分配，预计空闲堆为 1320 B。链接器报告 UART 任务直接调用路径最大 144 B，发送回调路径按调用链与驱动报告合计 160 B，均未计入抢占上下文。0-4C 实板栈高水位和堆余量待测。

- AXF 与 HTML 调用图位于 `firmware/Project/Objects/0-4C/`。
- Map 与汇编 Listing 位于 `firmware/Project/Listings/0-4C/`。
- 本次 Rebuild 日志为 `firmware/Project/rebuild-0-4C.log`。

## 离线测试

用主机 GCC 编译实际协议模块并运行。PowerShell 示例如下（开源仓库中固件位于 `firmware/`，命令在仓库根目录执行；若使用独立的固件仓库，去掉 `firmware/` 前缀）。

```powershell
$testExe = Join-Path ([IO.Path]::GetTempPath()) 'zily-uart-protocol-test.exe'
gcc -std=c99 -Wall -Wextra -Werror -Wconversion -pedantic -O2 -Ifirmware/App firmware/tests/uart_protocol_test.c firmware/App/zily_uart_protocol.c -o $testExe
if ($LASTEXITCODE -eq 0) { & $testExe }
```

主机测试通过标准 CRC 向量、四条 HEX 向量、分段帧头、连续帧、空和 256 B ECHO、Payload 内嵌帧、非法版本、LEN 257、CRC 失败重扫、超时恢复、流重置、未知和响应类型以及发送回调失败。另用模拟 USART 寄存器与 FreeRTOS 通知运行实际 ISR 和 UART 任务，验证排空期间发生帧错误、跨断点伪帧被阻断、断点后字节保留、TX 期间 RX 环溢出及随后恢复、环索引回绕和等待超时。

## 实板验证步骤

0-4C 尚未烧录。以下为验收步骤和预期现象。

1. 打开 `firmware/Project/Zily-Hardware.uvprojx`，确认目标产物为 `Objects/0-4C/Zily-Hardware.axf`。用现有 ST-Link SWD 接线执行 Keil **Flash → Download**。HW-597 用 3.3 V TTL 电平，GND 共地，转接器 RX 接 PA9，TX 接 PA10。
2. 打开串口助手，设 115200、8N1、无流控，关闭本地回显、自动换行和自动发送。先用文本接收观察复位后的 `ZILY UART1 READY`，并确认 PB12 仍周期闪烁。随后开启 HEX 发送和接收。
3. 分别发送上表 PING 和 ECHO 帧，逐字节比对两条回复。把两条请求拼接为同一次发送，预期依次得到两条回复。把 PING 拆成 `A5` 和余下 9 B，分段间隔小于 100 ms，预期仍收到 PONG。
4. 把 PING 末字节 `97` 改为 `96`，紧接一条正确 PING 一次发送。预期只收到正确 PING 的回复，CRC 错误计数增加。发送 `A5 5A 01 03 00 00 01 01` 后紧接正确 PING，预期 LEN 超限计数增加且收到 PONG。仅发送 `A5 5A 01 01 01`，等至少 150 ms 再发正确 PING，预期超时计数增加且收到 PONG。
5. 先发送一条 256 B Payload 的 ECHO，检查回复长度为 266 B 且 Payload 逐字节一致。随后用文件发送功能按原始字节连续发送最大帧，观察 `zilyUartRxOverflowCount`。停止发送并等串口空闲，再发送单独的正确 PING。发生溢出时预期 `zilyUartProtocolResetCount` 增加，PONG 恢复。若环满计数未增加，本次压力测试未触发溢出。
6. 在正常通信和最大帧 ECHO 后读取 Watch，记录 UART 栈高水位与堆余量，并查看故障、LED、事件生产者和消费者计数。对照 0-4B 实板基线 162 words 和 1320 B。

可用 Python 标准库生成最大 ECHO、预期回复和压力测试文件。`echo-max.bin` 的 Payload 包含 `A5 5A`，压力文件由 128 条最大帧组成。

```python
from binascii import crc_hqx
from pathlib import Path
from tempfile import gettempdir

def frame(command):
    payload = b"\xA5\x5A" + bytes(range(254))
    body = bytes((1, command, 0x34, 0x12, 0, 1)) + payload
    return b"\xA5\x5A" + body + crc_hqx(body, 0xFFFF).to_bytes(2, "little")

output = Path(gettempdir())
(output / "echo-max.bin").write_bytes(frame(3))
(output / "echo-max-reply.bin").write_bytes(frame(4))
(output / "echo-stress.bin").write_bytes(frame(3) * 128)
print(output)
```
