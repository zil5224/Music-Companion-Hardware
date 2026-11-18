# Zily-Hardware 0-3C 交付报告

本文保留 0-3C 关卡 A 和 B 的移植记录。该阶段的 FreeRTOS 内核和 LED 任务已通过 Keil MDK 5.24a、ARM Compiler 5.06 update 5 build 528 重编译，交付时待手动下载并完成板上调度验证。当前稳定版本和实板验证范围见 [0-3C-3-fix 多任务记录](0-3C-3-Multitask-Communication.md)。

## 源码与文件变更

- 官方 FreeRTOS Kernel [V11.1.0](https://github.com/FreeRTOS/FreeRTOS-Kernel/tree/V11.1.0)，标签对应提交 dbf70559b27d39c1fdb68dfb9a32140b6a6777a0。纳入的 27 个官方文件已与该固定提交归档逐字节比对，包括 MIT LICENSE、21 个 include 头文件及内核和移植文件。
- 新增 firmware/FreeRTOS 下的 LICENSE.md、UPSTREAM.md、Source、include、portable 和 Config。0-3C 关卡 A/B 参与构建的官方源文件为 tasks.c、list.c、RVDS/ARM_CM3/port.c、MemMang/heap_4.c。该阶段的链接无需 queue.c 或 timers.c。
- 修改 firmware/App/main.c 和 firmware/Project/Zily-Hardware.uvprojx。本地 uvoptx 只更新 Listing 路径，保留原 ST-Link 选择、SWD 和编程算法设置。
- 新增两阶段日志及产物，以及完整目录树所在的本报告。Objects/0-3C-baseline 保留裸机源码和配置快照，Objects/0-3C-A 保留关卡 A 的 AXF、工程快照和构建产物。通过预先记录的哈希确认原裸机 AXF、Map、日志、启动文件和 SystemInit 的最终内容。两次重编译期间 Keil 按本地 uvoptx 的旧路径写出了默认 Map，已归档 A/B Map 并恢复 SHA-256 一致的裸机 Map。

## 配置与移植

- 默认 SysTick 使用 8 MHz HCLK，tick 为 1000 Hz、32 位，反汇编确认重装值为 7999。启用抢占、时间片，4 个任务优先级。软件定时器、tickless 和 Tick Hook 关闭。配置按本版本 RVDS/ARM_CM3 端口使用 configCPU_CLOCK_HZ，未定义 configSYSTICK_CLOCK_HZ 和 configKERNEL_INTERRUPT_PRIORITY。
- 调度前通过 CMSIS 设置并回读 AIRCR.PRIGROUP=3。设备头文件和配置均为 4 位优先级，因此是 4 位抢占、0 位子优先级。库优先级上限 5 编码为 0x50，最低优先级为 15。端口用 BASEPRI 保护内核临界区，端口设置 PendSV 和 SysTick 为最低优先级。
- 动态分配开启，静态分配关闭，heap_4 为 4096 B。LED_Task 优先级 1，192 字即 768 B。Idle Task 由内核创建，128 字即 512 B。PB12 高有效推挽输出保持 2 MHz 档，每 500 个 tick 翻转一次，完整亮灭周期为 1 秒。任务用 xTaskGetTickCount 建立初始时间，再用 xTaskDelayUntil 周期阻塞。
- 启用 configASSERT、2 级栈溢出检查和分配失败 Hook。错误处理记录 zilyFaultReason 并停住，连接调试器时触发断点。1 为断言，查 zilyAssertFile / zilyAssertLine，2 为栈溢出，查 zilyOverflowTask / zilyOverflowTaskName，3 为堆分配失败。任务创建失败和调度器意外返回也进入故障处理。

## 构建与内存

| 关卡 | 错误 / 警告 | Flash | SRAM |
|---|---:|---:|---:|
| A 内核链接，保留裸机 main | 0 / 0 | 7040 B | 6000 B |
| B LED 任务和调度器 | 0 / 0 | 7224 B | 6008 B |

最终链接保留 64 KiB Flash 和 20 KiB SRAM 区域。剩余 58312 B Flash 和 14472 B SRAM。以下 SRAM 区间结束地址不计入区段。

| 区段 | 地址范围 | 大小 |
|---|---|---:|
| heap_4 ucHeap | [0x20000118, 0x20001118) | 4096 B |
| C 运行库堆 | [0x20001178, 0x20001378) | 512 B |
| MSP 栈 | [0x20001378, 0x20001778) | 1024 B |

三个区间互不重叠。初始 MSP 为 0x20001778，任务使用各自的 PSP 栈。反汇编确认动态创建任务分别向 pvPortMalloc 申请任务栈和 76 B TCB，二者均包含在 ucHeap 内。

| 异常 | 向量槽地址 | A Thumb 地址 | B Thumb 地址 | 实现 |
|---|---|---|---|---|
| SVC | 0x0800002C | 0x08000189 | 0x08000189 | port.o |
| PendSV | 0x08000038 | 0x080001CD | 0x080001CD | port.o |
| SysTick | 0x0800003C | 0x0800149B | 0x08001547 | port.o |

从两份 AXF 直接读取向量槽并与 Map 符号比较。向量表仍在 0x08000000，复位入口仍来自 DFP 启动文件。FreeRTOSConfig.h 将三个端口符号直接映射为启动文件的异常名。

## Keil 手动下载与验收

1. 打开 firmware/Project/Zily-Hardware.uvprojx。确认输出为 Objects/0-3C-B/Zily-Hardware.axf。沿用已经完成裸机验证的 PB12 LED 接线和 ST-Link SWD。
2. 在 Options for Target → Debug 确认 ST-Link Debugger，在 Utilities 确认 Use Debug Driver 和 STM32F10x_128 编程算法。从 Flash → Download 手动下载。
3. 复位运行，确认 LED 亮约 500 ms、灭约 500 ms。进入 Debug 并运行，再暂停查看以下 Watch 变量。避免每 1 ms 停在 SysTick 上观察 LED 时序。
4. zilyLedStackHighWaterWords 是 LED 任务运行以来最少的剩余栈字数，乘 4 得到字节数。zilyFreeHeapBytes 和 zilyMinFreeHeapBytes 是当前和历史最低堆余量，LED 任务每 500 ms 更新一次。zilyIdleCount 是仅由 Idle Hook 递增的调试计数，恢复运行后再暂停，应看到它增长。正常时 zilyFaultReason 为 0。
5. 如需观察 heap_4 初始化，在首次 pvPortMalloc 的 prvHeapInit 返回后检查 xFreeBytesRemaining 和 xMinimumEverFreeBytesRemaining。按最终 AXF 的 8 字节对齐、8 B 结束标记和每任务两块分配推算，初始化后约 4088 B，两任务创建后约 2616 B。上板读数、LED 栈高水位和实际调度状态待确认。

## 完整目录树

以下为 0-3C 交付时的历史目录树，包含 Keil 本地配置及构建产物。IDE 用户文件名使用通用示例，省略 .git 内部目录。

```text
Zily-Hardware/
├── docs/
│   ├── 0-3C-FreeRTOS.md
│   └── README.md
├── firmware/
│   ├── App/
│   │   ├── main.c
│   │   └── README.md
│   ├── Drivers/
│   │   └── README.md
│   ├── FreeRTOS/
│   │   ├── Config/
│   │   │   ├── FreeRTOSConfig.h
│   │   │   └── FreeRTOSHooks.c
│   │   ├── include/
│   │   │   ├── atomic.h
│   │   │   ├── croutine.h
│   │   │   ├── deprecated_definitions.h
│   │   │   ├── event_groups.h
│   │   │   ├── FreeRTOS.h
│   │   │   ├── list.h
│   │   │   ├── message_buffer.h
│   │   │   ├── mpu_prototypes.h
│   │   │   ├── mpu_syscall_numbers.h
│   │   │   ├── mpu_wrappers.h
│   │   │   ├── newlib-freertos.h
│   │   │   ├── picolibc-freertos.h
│   │   │   ├── portable.h
│   │   │   ├── projdefs.h
│   │   │   ├── queue.h
│   │   │   ├── semphr.h
│   │   │   ├── stack_macros.h
│   │   │   ├── StackMacros.h
│   │   │   ├── stream_buffer.h
│   │   │   ├── task.h
│   │   │   └── timers.h
│   │   ├── portable/
│   │   │   ├── MemMang/
│   │   │   │   └── heap_4.c
│   │   │   └── RVDS/
│   │   │       └── ARM_CM3/
│   │   │           ├── port.c
│   │   │           └── portmacro.h
│   │   ├── Source/
│   │   │   ├── list.c
│   │   │   └── tasks.c
│   │   ├── LICENSE.md
│   │   ├── README.md
│   │   └── UPSTREAM.md
│   └── Project/
│       ├── DebugConfig/
│       │   └── Zily-Hardware_STM32F103C8_1.0.0.dbgconf
│       ├── Listings/
│       │   ├── 0-3C-A/
│       │   │   └── Zily-Hardware.map
│       │   ├── 0-3C-B/
│       │   │   ├── Zily-Hardware.axf.txt
│       │   │   └── Zily-Hardware.map
│       │   ├── startup_stm32f10x_md.lst
│       │   ├── Zily-Hardware.axf.txt
│       │   └── Zily-Hardware.map
│       ├── Objects/
│       │   ├── 0-3C-A/
│       │   │   ├── freertoshooks.d
│       │   │   ├── freertoshooks.o
│       │   │   ├── heap_4.d
│       │   │   ├── heap_4.o
│       │   │   ├── list.d
│       │   │   ├── list.o
│       │   │   ├── main.d
│       │   │   ├── main.o
│       │   │   ├── port.d
│       │   │   ├── port.o
│       │   │   ├── startup_stm32f10x_md.d
│       │   │   ├── startup_stm32f10x_md.o
│       │   │   ├── system_stm32f10x.d
│       │   │   ├── system_stm32f10x.o
│       │   │   ├── tasks.d
│       │   │   ├── tasks.o
│       │   │   ├── Zily-Hardware.axf
│       │   │   ├── Zily-Hardware.build_log.htm
│       │   │   ├── Zily-Hardware.htm
│       │   │   ├── Zily-Hardware.lnp
│       │   │   ├── Zily-Hardware.sct
│       │   │   ├── Zily-Hardware.uvprojx.snapshot
│       │   │   └── Zily-Hardware_Zily-Hardware.dep
│       │   ├── 0-3C-B/
│       │   │   ├── freertoshooks.d
│       │   │   ├── freertoshooks.o
│       │   │   ├── heap_4.d
│       │   │   ├── heap_4.o
│       │   │   ├── list.d
│       │   │   ├── list.o
│       │   │   ├── main.d
│       │   │   ├── main.o
│       │   │   ├── port.d
│       │   │   ├── port.o
│       │   │   ├── startup_stm32f10x_md.d
│       │   │   ├── startup_stm32f10x_md.o
│       │   │   ├── system_stm32f10x.d
│       │   │   ├── system_stm32f10x.o
│       │   │   ├── tasks.d
│       │   │   ├── tasks.o
│       │   │   ├── Zily-Hardware.axf
│       │   │   ├── Zily-Hardware.build_log.htm
│       │   │   ├── Zily-Hardware.htm
│       │   │   ├── Zily-Hardware.lnp
│       │   │   ├── Zily-Hardware.sct
│       │   │   └── Zily-Hardware_Zily-Hardware.dep
│       │   ├── 0-3C-baseline/
│       │   │   ├── main.c.original
│       │   │   ├── protected.sha256
│       │   │   ├── recover.lnp
│       │   │   ├── Zily-Hardware.axf
│       │   │   ├── Zily-Hardware.htm
│       │   │   ├── Zily-Hardware.map
│       │   │   ├── Zily-Hardware.uvoptx.original
│       │   │   └── Zily-Hardware.uvprojx.original
│       │   ├── main.d
│       │   ├── main.o
│       │   ├── startup_stm32f10x_md.d
│       │   ├── startup_stm32f10x_md.o
│       │   ├── system_stm32f10x.d
│       │   ├── system_stm32f10x.o
│       │   ├── Zily-Hardware.axf
│       │   ├── Zily-Hardware.build_log.htm
│       │   ├── Zily-Hardware.htm
│       │   ├── Zily-Hardware.lnp
│       │   ├── Zily-Hardware.sct
│       │   └── Zily-Hardware_Zily-Hardware.dep
│       ├── RTE/
│       │   ├── _Zily-Hardware/
│       │   │   └── RTE_Components.h
│       │   └── Device/
│       │       └── STM32F103C8/
│       │           ├── RTE_Device.h
│       │           ├── startup_stm32f10x_md.s
│       │           └── system_stm32f10x.c
│       ├── README.md
│       ├── rebuild-0-3C-A.log
│       ├── rebuild-0-3C-B.log
│       ├── rebuild-ac5.log
│       ├── rebuild-final.log
│       ├── rebuild.log
│       ├── Zily-Hardware.uvguix.<用户名>
│       ├── Zily-Hardware.uvoptx
│       └── Zily-Hardware.uvprojx
├── .gitignore
└── README.md
```
