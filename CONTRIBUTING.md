# 参与贡献

感谢你愿意改进 Music Companion。这个项目同时包含网页应用和 STM32 固件，改动前请先确认改动落在哪一端。

## 开发环境

- Node.js ≥ 22.12.0（推荐 24.x）。
- 固件：Keil MDK5 + ARM Compiler 5.06 + STM32F1xx Device Family Pack。
- 只改固件逻辑时，可以用主机 gcc 跑单元测试，不需要 Keil 授权。

## 本地检查（提交前必须通过）

```powershell
npm.cmd ci
npm.cmd run check     # 全部 JS 语法检查
npm.cmd test          # 452 项测试
```

固件主机测试（在仓库根目录执行）：

```powershell
$flags = @('-std=c99','-Wall','-Wextra','-Werror','-Wconversion','-pedantic','-O2')
gcc @flags -Ifirmware/App -Ifirmware/Drivers/OLED `
  firmware/tests/uart_protocol_test.c firmware/App/zily_uart_protocol.c firmware/App/zily_app_state.c firmware/App/zily_display_service.c `
  -o (Join-Path $env:TEMP 'uart_protocol_test.exe')
& (Join-Path $env:TEMP 'uart_protocol_test.exe')
```

其余三个测试的命令见 `firmware/docs/` 对应协议文档；CI 会执行全部四个。

## 代码约定

- 网页端是原生脚本，不使用打包器。新增模块放在 `web/js/`，并在 `web/index.html` 末尾按依赖顺序引入；脚本编号沿用现有规则。
- 服务端是 CommonJS，新增路由或存储模块时保持“本机回环 + 同源”约束，不要引入公网鉴权假设。
- 固件遵循 ARMCC 5 的 C99 子集：不使用动态内存，不在中断里调用阻塞 API，新增任务需说明栈深度。
- 不要提交 `.env`、真实 API Key、浏览器配置、记忆库或备份文件。
- 协议字段一旦发布即视为冻结，改动必须同步更新 `firmware/docs/` 中的协议文档与示例帧。

## 提交与 PR

1. 从 `main` 拉出分支，提交信息使用 `feat:`、`fix:`、`docs:`、`refactor:`、`chore:` 前缀。
2. PR 描述写清：改了什么、为什么、怎么验证（命令与结果）；涉及硬件的改动请注明是否实板验证。
3. 界面或硬件行为有变化时，附截图或视频片段。
4. CI 必须全绿。

## 许可

提交代码即表示同意以仓库根目录的 MIT 许可证发布你的贡献。