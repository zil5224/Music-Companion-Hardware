# 项目文档

本目录记录 Zily 桌面音乐伴侣终端的固件设计、通信协议与调试说明。

> 路径约定：本文档中的路径以**开源仓库根目录**为基准，固件子工程位于 `firmware/`。若你使用的是独立固件仓库（或已 `cd firmware`），请去掉路径开头的 `firmware/`。

## 阅读顺序

| 主题 | 文档 | 内容 |
|---|---|---|
| 硬件与构建 | [../README.md](../README.md) | 引脚分配、接线、Keil 构建、烧录、主机测试 |
| 应用层协议 | [0-7A-App-Protocol.md](0-7A-App-Protocol.md) | TYPE 分配、APP_ACK、状态同步、命令语义 |
| 串口帧格式 | [0-4C-UART-Protocol.md](0-4C-UART-Protocol.md) | USART1 二进制协议 V1.0（PING/PONG/ECHO，已冻结） |
| OLED 显示协议 | [0-8A-OLED-Display-Protocol.md](0-8A-OLED-Display-Protocol.md) | BEGIN/DATA/END、1bpp 位图、区域刷新；播放器跟随与实时频谱 |
| 物理输入 | [0-9A-Input-Event-Protocol.md](0-9A-Input-Event-Protocol.md) | 编码器事件 0xC0/0xC1、单击/双击窗口、音量与播放动作 |
| 显示驱动 | [0-5-OLED.md](0-5-OLED.md) | SSD1306 与 I2C1 重映射（PB8/PB9） |
| 历史阶段 | [0-3C-FreeRTOS.md](0-3C-FreeRTOS.md)、[0-3C-3-Multitask-Communication.md](0-3C-3-Multitask-Communication.md) | FreeRTOS 移植与多任务通信的验证记录（演示任务已移除） |

## 协议版本总览

| 层 | 类型码 | 方向 | 说明 |
|---|---|---|---|
| 传输帧 | `A5 5A` + VER 0x01 + TYPE + SEQ + LEN + PAYLOAD + CRC16 | 双向 | CRC-16/CCITT-FALSE，覆盖 version→payload |
| 心跳 | `0x01` PING / `0x02` ECHO | 主机→设备 | 设备回 PONG / 原样回显 |
| 应用命令 | `0x10`–`0x13` | 主机→设备 | PAUSE / RESUME / NEXT / FAVORITE，带 APP_ACK |
| 设备事件 | `0xC0` KEY_EVENT / `0xC1` ENCODER_EVENT | 设备→主机 | 无 ACK，尽力而为 |
| 显示 | `0x40` BEGIN / `0x41` DATA / `0x42` END，ACK `0x91` | 主机→设备 | 会话式位图传输，忙时整帧丢弃 |

## 验证

固件主机测试（无需 Keil 授权，在仓库根目录执行）：

```powershell
$flags = '-std=c99 -Wall -Wextra -Werror -Wconversion -pedantic -O2'
gcc $flags -Ifirmware/App -Ifirmware/Drivers/OLED `
  firmware/tests/uart_protocol_test.c firmware/App/zily_uart_protocol.c firmware/App/zily_app_state.c firmware/App/zily_display_service.c `
  -o (Join-Path $env:TEMP 'uart_protocol_test.exe')
```

其余三个测试的命令见各协议文档末尾的“测试与实板验收”一节；CI 会全部执行。