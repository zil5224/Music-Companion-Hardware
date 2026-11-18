# 开发与发布

## 环境

| 端 | 需要 |
|---|---|
| 网页应用 | Node.js ≥ 22.12.0（推荐 24.x）、npm |
| 固件 | Keil MDK5、ARM Compiler 5.06、STM32F1xx DFP；或只用主机 gcc 跑单元测试 |

```powershell
npm.cmd ci
npm.cmd run check   # 全部 JS 语法检查（scripts/check-syntax.cjs）
npm.cmd test        # 452 项测试（node --test）
npm.cmd start       # 同时启动网页服务与网易云音乐子服务
```

## 目录约定

```
web/            原生前端（index.html + css + js，无打包器）
server/         Node 服务端（聊天、搜索、记忆、备份、音乐代理）
scripts/        启动脚本、命令行检查、浏览器验收脚本
test/           node --test 测试，按功能命名
docs/           架构、硬件、隐私、开发文档
firmware/       STM32 固件子工程（Keil 工程 + FreeRTOS + 协议文档 + 主机测试）
  App/ Drivers/ FreeRTOS/ Project/ docs/ tests/
```

## 测试与 CI

- `npm run check`：对 `web/ server/ scripts/ test/` 全部 JavaScript 做解析检查，不做执行。
- `npm test`：覆盖 SSE、播放队列、歌单、记忆、聊天持久化、备份恢复、身份隔离、串口协议与 OLED 渲染等。
- `npm run check` 与 `npm test` 在 CI 的 `app` job 执行；`firmware` job 用 gcc 严格告警（`-Wall -Wextra -Werror -Wconversion -pedantic`）编译并运行四个主机测试。
- 浏览器验收脚本（可选，需要本机 Chrome）：`node scripts/backup-browser-acceptance.cjs`、`node scripts/privacy-browser-acceptance.cjs`。

## 新增一条硬件协议命令

以加一条应用命令为例，两端要同步改：

1. `firmware/docs/0-7A-App-Protocol.md`：先定 TYPE、载荷与 ACK 语义。
2. 固件：`firmware/App/zily_uart_protocol.c` 的命令分发、`firmware/App/zily_app_state.c` 的状态字段；`firmware/tests/uart_protocol_test.c` 补金标向量。
3. 网页：`web/js/28-app-protocol.js` 的常量与校验、`web/js/27-hardware-panel.js` 的按钮或调用点、`web/js/32-device-events.js`（若与输入事件相关）。
4. 测试：`test/app-protocol.test.js`、`test/web-serial.test.js`，必要时补 `test/device-events.test.js`。
5. 文档：更新协议文档末尾的变更记录与示例帧。

显示相关改动同理，先改 `0-8A` 文档，再改 `29-oled-display.js` 与固件 `zily_display_service.c`。

## 发布流程

1. 确认 `npm run check`、`npm test`、固件 gcc 测试与 Keil Rebuild 全部通过。
2. 更新 `CHANGELOG.md` 与 `package.json` 版本号。
3. 提交并打 tag（`vX.Y.Z`），在 GitHub 创建 Release，写明新增、修复与不兼容变更。
4. 隐私检查：确认没有提交 `.env`、密钥、浏览器配置、记忆库、备份或含个人信息的截图/视频。

## 固件构建与烧录

见 [firmware/README.md](../firmware/README.md) 与 [hardware.md](hardware.md)。

## 许可

代码以 MIT 许可发布；FreeRTOS 遵循其自带 MIT 许可；STM32 启动文件与设备头来自 ST 官方 DFP。歌曲、歌词、封面与音源权利归对应权利人。