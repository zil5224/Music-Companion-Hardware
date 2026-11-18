# Zily-Hardware 固件

Zily 桌面音乐伴侣终端的 STM32 固件子工程。目标芯片 STM32F103C8T6（Blue Pill，64 KB Flash / 20 KB SRAM），标称 8 MHz HSI，FreeRTOS Kernel V11.1.0，ARMCC 5.06（Keil MDK5），`heap_4` 内存管理。

固件通过 USART1 接收网页端下发的二进制帧：显示命令把歌曲信息与 1bpp 位图推到 SSD1306 OLED；应用命令同步播放/收藏状态；编码器事件（旋转、单击、双击）回传给网页控制音量与播放。

## 当前状态

本仓库对应固件阶段 **0-9A**（首个公开快照），已实现并实板验证：

- USART1 二进制协议 V1.0（PING/PONG/ECHO）与 CRC-16/CCITT-FALSE 校验。
- 应用层命令 PAUSE / RESUME / NEXT / FAVORITE 与 APP_ACK、状态回写（0-7A）。
- OLED 驱动（SSD1306，I2C1 重映射）与显示协议 BEGIN/DATA/END、区域刷新（0-5、0-8A）。
- 网页端播放器跟随：中文歌名/歌手/时间/进度条、长标题滚动、24 柱实时频谱。
- 旋转编码器输入（0-9A）：旋转调音量（每档 ±5%）、单击暂停/继续、双击下一首，事件无 ACK。
- PB12 状态灯 500 ms 周期翻转。

不在 V1 范围（相关驱动与演示代码已从产品构建中移除，可在 git 历史中查看）：四种颜色 LED 与 PWM 呼吸灯、光敏电阻、独立按键 KEY1/KEY2。

## 目录结构

| 路径 | 内容 |
|---|---|
| `App/` | 应用层：`main.c`、串口服务与协议、显示服务、输入服务、应用状态、开机自检 |
| `Drivers/` | 外设驱动：USART、I2C、OLED、按键、编码器、板级映射 |
| `FreeRTOS/` | FreeRTOS V11.1.0 内核源码、ARM_CM3 移植层、配置与钩子 |
| `Project/` | Keil MDK 工程（`Zily-Hardware.uvprojx`）与启动/设备文件 |
| `tests/` | 可在主机用 gcc 编译运行的单元测试（无需 Keil 授权） |
| `docs/` | 协议与设计文档，见 [docs/README.md](docs/README.md) |

## 引脚与接线

| 功能 | STM32 引脚 | 对端 | 说明 |
|---|---|---|---|
| 串口 TX | PA9 | CH340 RX | USART1，115200 8N1 |
| 串口 RX | PA10 | CH340 TX | 上拉输入 |
| OLED SCL | PB8 | SSD1306 SCL | I2C1 重映射，地址 `0x3C` |
| OLED SDA | PB9 | SSD1306 SDA | I2C1 重映射 |
| 编码器 A | PA6 | EC11 A | TIM3 编码器模式，上拉 |
| 编码器 B | PA7 | EC11 B | TIM3 编码器模式，上拉 |
| 编码器按下 | PA5 | EC11 SW | 内部上拉，按下为低 |
| 状态灯 | PB12 | 板载 LED | 高电平点亮，500 ms 翻转 |
| 电源 | 3.3V / 5V、GND | 各模块 | 与 CH340 共地 |

编码器以 4 计数为一档（机械档位）。方向相反时把 `App/zily_input_service.h` 中的 `ZILY_INPUT_ENCODER_DIRECTION` 改为 `(-1)` 后重新编译。

## 构建

1. 安装 Keil MDK5、ARM Compiler 5.06 与 STM32F1xx Device Family Pack。
2. 打开 `Project/Zily-Hardware.uvprojx`，目标名 `Zily-Hardware`，Rebuild All。
3. 产物在 `Project/Objects/0-9A/`：`Zily-Hardware.axf` 与 `Zily-Hardware.hex`（工程已开启 hex 输出）。

命令行构建（可选）：

```powershell
& 'C:\Keil_v5\UV4\UV4.exe' -b Project\Zily-Hardware.uvprojx -j0 -o build.log
```

期望输出 `0 Error(s), 0 Warning(s)`。

## 烧录

用 ST-Link（SWD：3.3V、GND、SWDIO、SWCLK）。工程默认的下载驱动是 ULINK2，**第一次用 ST-Link 时要改两处设置**（只需一次，Keil 会记在本地 `Zily-Hardware.uvoptx` 里）：

1. `Options for Target`（Alt+F7）→ **Debug** 页 → 右侧下拉选 **ST-Link Debugger** → `Settings` → Port 选 `SW`，能看到 `SW Device`（ID 通常 `0x1BA01477`，STM32F10x）说明连接正常。
2. 同一窗口 → **Utilities** 页 → 勾选 `Use Target Driver for Flash Programming`，下拉同样选 **ST-Link Debugger**，并勾选 `Update Target before Debugging`。

设置好后 **Flash → Download（F8）**，或直接点工具栏的 LOAD 按钮。没有改成 ST-Link 就点下载，会提示找不到 ULINK2 设备或无法下载。

如果下载时报 `Flash Download failed - "Cortex-M3"`，说明切换下载驱动后**编程算法列表是空的**：`Utilities → Settings…` → `Flash Download` 标签页 → `Programming Algorithm` 里点 `Add`，选 `STM32F10x Med-density Flash`（对应 `STM32F10x_128.FLM`），确认 Start `0x08000000`、Size `0x10000`（C8 是 64 KB），再点 OK 重新下载。

也可以在 Keil 里 Debug → Start/Stop Debug Session（Ctrl+F5）进入调试会话后再下载。若用 STM32CubeProgrammer，则选择 ST-Link + SWD，加载 `Project/Objects/0-9A/Zily-Hardware.hex` 后点 Download。

上电后串口会收到 `ZILY UART1 READY`，PB12 开始闪烁。默认构建屏幕保持空白，网页通过串口下发首帧后才有画面；需要在无主机时检查面板接线，可把 `App/main.c` 中的 `ZILY_BOOT_SELFTEST` 设为 `1` 重新编译，开机将运行约 2 秒的图案自检。

## 主机测试（无需 Keil）

在仓库根目录（固件位于 `firmware/`；独立固件仓库请去掉 `firmware/` 前缀）：

```powershell
$flags = @('-std=c99','-Wall','-Wextra','-Werror','-Wconversion','-pedantic','-O2')
gcc @flags -Ifirmware/App -Ifirmware/Drivers/OLED `
  firmware/tests/uart_protocol_test.c firmware/App/zily_uart_protocol.c firmware/App/zily_app_state.c firmware/App/zily_display_service.c `
  -o (Join-Path $env:TEMP 'uart_protocol_test.exe')
& (Join-Path $env:TEMP 'uart_protocol_test.exe')
```

`tests/` 下四个测试分别覆盖协议层、输入服务、显示服务与 OLED 驱动，CI 会依次编译并运行。

## 第三方组件

FreeRTOS Kernel V11.1.0 以源码形式随仓库提供，遵循 MIT 许可，见 [FreeRTOS/LICENSE.md](FreeRTOS/LICENSE.md) 与 [FreeRTOS/UPSTREAM.md](FreeRTOS/UPSTREAM.md)。CMSIS 与 STM32F1 启动文件来自 ST 官方 Device Family Pack。

本项目源码采用 MIT 许可证，见仓库根目录 `LICENSE`。