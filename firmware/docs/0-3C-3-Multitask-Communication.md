# Zily-Hardware 0-3C-3-fix 多任务与任务间通信

**历史阶段说明**：`0-3C-3` 的 EventProducerTask / EventConsumerTask 与 `ZilyEventQueue` 是为验证 FreeRTOS 队列与任务通知而加入的演示代码，已在后续版本整理中移除；当前固件只保留 `LED_Task` 与 `UART_ServiceTask`。本文保留作为该阶段的实现与验证记录，引用到的 `zily_rtos_demo.c` 不复存在于源码树，可在 git 历史中查看。

`0-3C-3-fix` 是阶段 0-3C-3 的稳定版本。模拟事件用于学习 Queue、Task Notification 和抢占调度。事件内容为递增序号及序号乘以 10 的数值。

## 任务与通信

| 任务 | 优先级 | 栈深度 | 行为 |
|---|---:|---:|---|
| LED_Task | 1 | 192 字 / 768 B | PB12 高有效，每 500 ms 翻转一次，完整亮灭周期约 1 秒 |
| EventProducerTask | 1 | 128 字 / 512 B | 启动约 2 秒后发送首个事件，随后每 2 秒发送一次 |
| EventConsumerTask | 2 | 160 字 / 640 B | 等待索引 0 的通知，醒后清空队列，再次阻塞 |
| IDLE | 0 | 128 字 / 512 B | 内核创建，Idle Hook 递增计数器 |

启动调度器前依次创建 LED 任务、4 项的 ZilyEventQueue、消费者和生产者。每条消息有两个 uint32_t 字段，共 8 B。队列在官方 Queue Registry 中注册为 ZilyEventQueue。队列或任务创建失败进入已有故障处理。

生产者用 xTaskDelayUntil() 定期唤醒，使用 xQueueSend(..., 0) 非阻塞入队。成功后才调用 xTaskNotifyGive()，队列满时增加失败计数。消费者用 ulTaskNotifyTake(pdTRUE, portMAX_DELAY) 取走并清零当前累计通知，之后反复调用 xQueueReceive(..., 0) 处理全部待收事件。通知累计值、唤醒批次和收到的消息分别计数，便于观察合并唤醒。

消费者创建时通过 `xTaskCreate()` 的输出参数保存 `xEventConsumerTaskHandle`，创建成功后才启动调度器。旧版消费者在唤醒后调用 `eTaskGetState(NULL)`，触发内核的非空句柄断言。修复版调用 `eTaskGetState(xEventConsumerTaskHandle)`，由生产者和消费者用同一个有效句柄采样消费者状态。

## FreeRTOS 配置和源码

沿用 ARMCC 5.06 update 5 build 528、FreeRTOS Kernel V11.1.0 的 RVDS ARM_CM3 移植层、heap_4、标称 8 MHz 的 HSI、1 kHz SysTick、4 KiB RTOS 堆、现有启动文件和链接布局。当前任务通信使用以下配置。

| 配置 | 值 | 用途 |
|---|---:|---|
| configUSE_TASK_NOTIFICATIONS | 1 | 显式启用直接通知，使用默认索引 0 |
| INCLUDE_eTaskGetState | 1 | 获取调度器的任务状态快照 |
| INCLUDE_vTaskSuspend | 1 | 使 V11.1.0 的 portMAX_DELAY 支持无限等待 |
| configQUEUE_REGISTRY_SIZE | 1 | 为 ZilyEventQueue 保留名称登记项 |
| configMAX_TASK_NAME_LEN | 18 | 完整容纳两个任务名和结尾 NUL |

工程使用官方 queue.c。V11.1.0 标签和固定提交 dbf70559b27d39c1fdb68dfb9a32140b6a6777a0 的 queue.c 内容一致。SHA-256 为 e66b73eb6dd7e6b2ccd121ab8d7345ab9698cd655b32171476643284e6dc4f4a。 [官方固定源码](https://github.com/FreeRTOS/FreeRTOS-Kernel/blob/dbf70559b27d39c1fdb68dfb9a32140b6a6777a0/queue.c)

## 构建与内存

`0-3C-3-fix` 的 Keil Rebuild All 记录为 0 错误、0 警告。当前输出目录为工程目录下的 `Objects/0-3C-3-fix/`，Listing 目录为 `Listings/0-3C-3-fix/`。

Map 确认 queue.o 提供 xQueueGenericCreate、xQueueGenericSend、xQueueReceive 和队列登记表。最终 AXF 在 Flash 的向量表首地址为 0x08000000。SVC、PendSV、SysTick 槽分别为 0x08000189、0x080001CD、0x080024D7，均由 port.o 实现。复位向量为 0x08002911，来自原 DFP 启动文件。

Flash 使用 11,516 / 65,536 B，剩余 54,020 B。SRAM 使用 6,096 / 20,480 B，剩余 14,384 B。以下区间结束地址不计入该区间。

| 区段 | 地址范围 | 大小 |
|---|---|---:|
| ucHeap | [0x20000170, 0x20001170) | 4096 B |
| C 运行库堆 | [0x200011D0, 0x200013D0) | 512 B |
| MSP 栈 | [0x200013D0, 0x200017D0) | 1024 B |

三个区段互不重叠，AXF 的初始 MSP 为 0x200017D0。任务栈和 TCB 均从 ucHeap 分配，已经计入 SRAM。队列控制结构和 4 项存储由 xQueueCreate() 一次分配。Queue Registry 另用 8 B 链接区静态空间。

| 堆分配 | 栈 / 存储 | 控制块 | heap_4 块头 | 合计 |
|---|---:|---:|---:|---:|
| LED_Task | 768 B | 80 B | 16 B | 864 B |
| EventProducerTask | 512 B | 80 B | 16 B | 608 B |
| EventConsumerTask | 640 B | 80 B | 16 B | 736 B |
| IDLE | 512 B | 80 B | 16 B | 608 B |
| ZilyEventQueue | 32 B | 72 B | 8 B | 112 B |
| 合计 | 2432 B 任务栈 + 32 B 队列存储 | 392 B | 72 B | 2928 B |

修复版反汇编确认每个 TCB 请求 0x50 B，队列请求 0x48 B 加消息存储。ucHeap 已按 8 字节对齐，结束标记占 8 B。静态推算初始可分配 4088 B，四个任务及队列创建后预计剩余 1160 B。运行时的当前和历史最低堆余量，以及各任务栈高水位，待实板读数确认。

## 实板验证与后续验收

实板已重新下载 `0-3C-3-fix`，确认 PB12 LED 可以持续周期闪烁。队列和通知的 Watch 读数、抢占顺序、队列压力、运行时堆余量和任务栈高水位仍待验收。以下步骤用于复现已验证的 LED 行为并继续检查其余项目。

1. 打开 Zily-Hardware.uvprojx，确认输出为 `Objects/0-3C-3-fix/Zily-Hardware.axf`。沿用裸机验证的 ST-Link SWD 接线，检查 Debug 中的 ST-Link Debugger 及 Flash Download 中的 STM32F10x_128，手动执行 Flash → Download。
2. 复位运行 6–10 秒后暂停。PB12 仍应亮约 500 ms、灭约 500 ms。zilyFaultReason 应为 0，zilyIdleCount 应在两次运行后的采样间增长。
3. 将下表变量加入 Watch。稳定采样时，正常情况下发送、接收、通知累计和通知返回计数同步递增，失败计数和队列深度回到 0。队列深度是最近采样值，断在入队和清队之间时可看到非零值。
4. 要验证抢占，先断在生产者调用 xTaskNotifyGive() 前，确认 zilyConsumerTaskState 为 2。然后在消费者将 `eTaskGetState(xEventConsumerTaskHandle)` 的返回值写入 `zilyConsumerTaskState` 之后，以及生产者的 ++zilyProducerAfterNotifyCount 处各设断点，使用 Run 继续。预期先停在消费者，此时状态为 0，发送数比通知返回数多 1。再继续，预期在生产者从通知调用返回时看到消费者已再次阻塞。若源级断点被优化合并，可用 Disassembly 在对应指令设断点。多次观察状态和计数可区分瞬态与稳定状态。

| Watch 变量 | 含义 |
|---|---|
| zilyEventProducedCount、zilyEventConsumedCount | 成功入队和已处理事件的累计数 |
| zilyQueueSendFailCount | 队列非阻塞发送失败数 |
| zilyNotificationWakeCount、zilyNotificationCount | 消费者醒来批次、ulTaskNotifyTake() 返回的通知值累计 |
| zilyLastEventSequence、zilyLastEventValue | 最后处理的序号和载荷，正常载荷为序号乘 10 |
| zilyEventQueueMessagesWaiting | 入队后、发送失败后或清队后的队列深度快照 |
| zilyProducerAfterNotifyCount | 生产者从 xTaskNotifyGive() 返回后递增 |
| zilyConsumerBeforeNotifyReturnCount | 消费者在生产者更新返回计数前运行的批次数 |
| zilyConsumerTaskState | eTaskGetState() 最近采样值，0 为 Running，1 为 Ready，2 为 Blocked，5 为初始化占位 eInvalid |
| zilyLedStackHighWaterWords、zilyProducerStackHighWaterWords、zilyConsumerStackHighWaterWords | 任务历史最少剩余栈字数，乘 4 得到字节数 |
| zilyFreeHeapBytes、zilyMinFreeHeapBytes | 当前、历史最低剩余 RTOS 堆，LED 任务每 500 ms 采样 |
| zilyIdleCount、zilyFaultReason | Idle 计数和故障原因 |
| zilyAssertFile、zilyAssertLine、zilyOverflowTask、zilyOverflowTaskName | 故障定位信息。分配失败时 reason 为 3，可从 Call Stack 查看创建位置，从 heap_4 的 xFreeBytesRemaining 读取当时余量 |

## 文件与历史产物

- 新增 firmware/App/zily_rtos_demo.c、firmware/App/zily_rtos_demo.h、firmware/FreeRTOS/Source/queue.c 和本报告。
- 修改 firmware/App/main.c、firmware/FreeRTOS/Config/FreeRTOSConfig.h、firmware/Project/Zily-Hardware.uvprojx。仅调整本地 uvoptx 的 Listing 路径。
- `0-3C-3-fix` 修正消费者状态查询的句柄，Keil 工程和本机 Listing 设置使用相应的输出目录。
- 早期阶段的 AXF、Map、反汇编和快照可在本机 `Objects/`、`Listings/` 中查阅，日志也保存在本机。这些产物由 Git 忽略。
- 0-3C-3 初次交付时核验了 36 个历史产物和原配置文件的哈希，包括 0-3C-B 的 AXF、Map 和日志。
