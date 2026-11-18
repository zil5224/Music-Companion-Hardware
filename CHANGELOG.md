# 变更记录

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## 1.1.0 — 硬件伴侣首发

首个把网页应用与 STM32 固件放在一起发布的版本。

**新增**

- Zily 硬件伴侣固件（STM32F103C8T6 + FreeRTOS V11.1.0，阶段 0-9A）：USART1 二进制协议、应用命令与状态回写、SSD1306 OLED 显示协议、旋转编码器输入。
- 网页端 Web Serial 集成：硬件面板、应用命令、OLED 跟随播放、24 柱实时频谱、长标题滚动。
- 17 秒实机演示视频与硬件封面（`docs/media/`）。
- 硬件接线、构建与烧录文档（`docs/hardware.md`、`firmware/` 子工程）。
- 固件主机单元测试与 CI 的 `firmware` job。
- `npm run check` 覆盖全部 JavaScript 语法检查。

**清理**

- 移除未使用的聊天辅助函数与音频可视化残留变量（无行为变化）。
- 固件移除已取消的四色 LED 驱动与 PWM 演示、FreeRTOS 队列演示任务。
- 固件工程目录扁平化，开启 hex 产物输出。
- 修复 `tests/oled_test.c` 在严格告警（`-Wconversion`）下的编译失败。

## 1.0.0 — 网页版首发

- 原生 HTML/CSS/JavaScript 电台界面与 Node.js 服务端。
- 流式对话、自然语言点歌、播放队列、智能歌单、长期记忆、数据备份与恢复。
- BYOK：模型 Key 只保存在本机 `.env`，由服务端读取。
- 452 项自动化测试；历史仓库：<https://github.com/zil5224/Music-Companion>。