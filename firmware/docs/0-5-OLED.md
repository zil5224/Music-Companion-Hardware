# 0-5 OLED I2C 驱动与基础显示

## 实际接线与显示配置

四针 I2C 模块的接线已确认。`0-5-remap` 将 I2C1 从 PB6/PB7 切换到 PB8/PB9。显示驱动沿用暂定的 SSD1306、128×64、7-bit 地址 `0x3C`、内置电荷泵配置。实物控制器、分辨率、地址、上拉与显示效果待实板验证。板级配置集中在 `firmware/Drivers/zily_display_board.h`。

| 模块针脚 | 已确认接线 |
| --- | --- |
| GND | 开发板 GND，经面包板负极电源轨 |
| VCC | 开发板 3.3 V，经面包板正极电源轨 |
| SCL | PB8，I2C1 重映射 |
| SDA | PB9，I2C1 重映射 |

当前工程没有其他功能占用 PB8/PB9。USART1 使用 PA9/PA10，LED 使用 PB12。总线调试时可检查 SCL/SDA 上拉及空闲电平。

## I2C 与 OLED 接口

初始化先开启 AFIO、GPIOB 和 I2C1 时钟，在 `I2C1_CR1.PE=0` 时置位 `AFIO_MAPR.I2C1_REMAP`。读改写保留其他可读映射位。`SWJ_CFG` 为只写字段，写 `111` 对调试模式无影响。`GPIOB_CRH` 只更新 PB8/PB9 的配置字段，每针设置为 `CNF=11`、`MODE=10`（复用开漏，GPIO 速度档 2 MHz），之后才使能 I2C1。BUSY 恢复也使用同一组引脚。

I2C1 使用复用开漏和 100 kHz 标准模式。当前 HSI、HCLK、PCLK1 均为标称 8 MHz，计算得到 `CR2.FREQ=8`、`CCR=40`、`TRISE=9`。驱动用轮询完成 START、7-bit 写地址、控制字节、数据和 STOP。等待 ADDR 后读 SR2 清除该标志，最后等待 BTF 再发 STOP。各事件的等待上限是 10,000 次寄存器轮询，超时、NACK、总线错误与仲裁丢失分别返回。初始化时线路为高且 BUSY 超时，按 ES096 做一次有限的模拟滤波器恢复。 [STM32 RM0008](https://www.st.com/resource/en/reference_manual/rm0008-stm32f103xx-advanced-armbased-32bit-mcus-stmicroelectronics.pdf) · [STM32 ES096](https://www.st.com/resource/en/errata_sheet/es096-stm32f101x8b-stm32f102x8b-and-stm32f103x8b-mediumdensity-device-limitations-stmicroelectronics.pdf)

SSD1306 在显示关闭时配置时钟、64 行复用、起始行、偏移、内部电荷泵、页寻址、扫描方向、对比度和正常显示模式。清空显存后发送开屏命令。驱动使用一份 1,024 B 静态 framebuffer，每页 128 列，每字节存同列 8 个像素。 [SSD1306 数据手册及电荷泵应用笔记](https://cdn-shop.adafruit.com/datasheets/SSD1306.pdf)

- `SetPixel`、`DrawLine`、`DrawRect`、`FillRect`、`DrawBitmap` 和 `Clear` 只修改 framebuffer。线段端点须在屏幕内，矩形和位图会裁剪右边缘、下边缘。
- `DrawBitmap` 接受逐行 1bpp 数据。每行跨度为 `(width + 7) / 8`，每字节最高位在左，`1` 点亮，`0` 熄灭。接口校验源数据长度，位图格式独立于 OLED 页布局。
- `Flush` 刷新整屏。`FlushRegion(x, y, width, height)` 只发送指定列与覆盖到的页。由于 SSD1306 以字节写入，首尾页中同列、位于请求区域之外的像素也按 framebuffer 当前值发送。频谱等高频更新区可按 8 像素页边界布局，减少相邻区域一并发送。
- 例如，刷新 `13×9` 位图区域 `(57,29)` 时发送两页共 26 个像素数据字节，另有地址与命令开销。先用 `FillRect(..., 0)` 擦除旧图，再绘制新图，最后调用一次 `FlushRegion` 即可提交区域内容。

## 未来播放器主界面

界面只保留以下四项，由未来的 UI 层调用 OLED 驱动绘制。

| 位置 | 内容 |
| --- | --- |
| 顶部 | 大字号歌曲名，过长时在标题区域内滚动 |
| 标题下方 | 小字号歌手名 |
| 中部 | 8～10 根动态柱状频谱，作为主要动态元素 |
| 底部 | 当前时间、总时长和进度条 |

界面省去 `PLAY`、`NOW PLAYING`、`ZILY MUSIC`、`CONNECTED`、项目名称及功能介绍、子超陪伴文案、AI 伙伴头像和表情。中文歌曲名和歌手名后续在网页端渲染为 1bpp 位图。

后续复用网页端 `web/js/06-audio.js` 中的 Web Audio `AnalyserNode`，将现有 48 柱对应的频谱数据聚合为 8～10 个频段。网页端通过未来扩展的 USART1 协议发送频段数据，STM32 的 UI 层更新柱高并单独刷新频谱区域。暂停时停止频谱动态更新，恢复播放后继续。0-5 的交付范围是本地显示驱动和测试图案，串口协议仍为 0-4C V1.0。

## 构建、内存和测试

`0-5-remap` 使用 Keil MDK 5.24a、ARMCC 5.06 update 5 build 528 执行 Rebuild All，0 错误、0 警告。AXF 位于 `firmware/Project/Objects/0-5-remap/Zily-Hardware.axf`，Map 和汇编 Listing 位于 `firmware/Project/Listings/0-5-remap/`，日志位于 `firmware/Project/rebuild-0-5-remap.log`。若本地已有同名 `.uvoptx`，核对其中的 `ListingPath` 也为 `.\Listings\0-5-remap\`，Keil 会优先采用该路径。

| Map 项目 | 0-4C | 0-5 | 0-5-remap | 较 0-5 增量 |
| --- | ---: | ---: | ---: | ---: |
| Flash 装载（Total ROM） | 13,212 B | 15,284 B | 15,316 B | +32 B |
| SRAM（Total RW） | 8,280 B | 9,328 B | 9,328 B | 0 B |
| FreeRTOS Heap（`ucHeap`） | 5,120 B | 5,120 B | 5,120 B | 0 B |

相比 0-4C，SRAM 增量包括 1,024 B framebuffer、20 B Watch 计数及 4 B 链接布局增量。I2C 驱动及测试模块没有静态 RAM 数据，OLED 不使用动态分配。MSP 为 1,024 B。现有任务栈分别为 LED 192、生产者 128、消费者 160、UART 192、Idle 128 words。实板堆余量与任务栈高水位待复核。

主机用模拟 I2C 验证了清屏、全屏点亮、边框、棋盘格、坐标、位图、重复刷新、区域页与列范围、裁剪及错误计数。原 UART 协议主机回归测试通过。硬件 I2C 时序、上拉、OLED 显示及 0-5 固件上的 UART 与 LED 回归待实板验证。

## 实板验收

1. 按已确认的 PB8/PB9 与供电接线，用 ST-Link SWD 烧录 `0-5-remap` AXF。打开串口助手，设 115200、8N1、无流控。
2. 复位后观察清屏、全亮、边框、棋盘格、四角和中心十字。最后屏幕应停在边框与向右箭头，箭头区域连续擦除和重绘三次。成功时 `zilyOledFlushCount` 为 12，其中 6 次整屏、6 次局部刷新。
3. 启动自检完成或提前退出后，串口应出现 `ZILY UART1 READY`，PB12 随后周期闪烁。按 [0-4C 协议验收步骤](0-4C-UART-Protocol.md) 检查 PING/PONG 与 ECHO。
4. 在 Watch 检查 `zilyOledInitFailed`、`zilyOledI2cErrorCount`、`zilyOledTimeoutCount` 和 `zilyOledLastError`。正常启动时四项均为 0。错误码 `1` 为超时，检查供电、共地、SCL/SDA 空闲电平及上拉。`2` 为 NACK，检查 7-bit 地址、接口模式、接线与模块上电。`3` 为总线错误，检查波形、干扰与接触。`4` 为仲裁丢失，`5` 为无效参数，`6` 为无效 PCLK1。
5. 断电拔掉 OLED 后重新启动，检查 READY、PB12 和 UART 回归。启动自检单次执行，OLED 失败后返回 `main`，继续原任务创建和调度启动。DWT 仅用于启动图案停留，FreeRTOS 的 SysTick 由原移植层配置。
