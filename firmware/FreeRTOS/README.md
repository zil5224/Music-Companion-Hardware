# FreeRTOS

当前工程使用 FreeRTOS Kernel V11.1.0，固定官方提交为 `dbf70559b27d39c1fdb68dfb9a32140b6a6777a0`。Keil 工程使用 ARMCC5 编译，采用 RVDS `ARM_CM3` 移植层和 `heap_4` 动态内存管理。

| 文件 | 用途 |
|---|---|
| [`Source/tasks.c`](Source/tasks.c)、[`Source/list.c`](Source/list.c)、[`Source/queue.c`](Source/queue.c) | 任务调度与通知、内核链表、队列 |
| [`portable/RVDS/ARM_CM3/port.c`](portable/RVDS/ARM_CM3/port.c)、[`portable/RVDS/ARM_CM3/portmacro.h`](portable/RVDS/ARM_CM3/portmacro.h) | Cortex-M3 移植层 |
| [`portable/MemMang/heap_4.c`](portable/MemMang/heap_4.c) | FreeRTOS 堆分配器 |
| [`Config/FreeRTOSConfig.h`](Config/FreeRTOSConfig.h)、[`Config/FreeRTOSHooks.c`](Config/FreeRTOSHooks.c) | 本工程的内核配置和 Hook |

上游代码采用 MIT 许可证。版本与来源见 [UPSTREAM.md](UPSTREAM.md)，许可全文见 [LICENSE.md](LICENSE.md)。
