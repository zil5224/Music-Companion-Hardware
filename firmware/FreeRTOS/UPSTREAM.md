# FreeRTOS Kernel V11.1.0

- [Official FreeRTOS-Kernel repository](https://github.com/FreeRTOS/FreeRTOS-Kernel)
- Pinned version [V11.1.0](https://github.com/FreeRTOS/FreeRTOS-Kernel/tree/V11.1.0)
- Pinned commit [`dbf70559b27d39c1fdb68dfb9a32140b6a6777a0`](https://github.com/FreeRTOS/FreeRTOS-Kernel/tree/dbf70559b27d39c1fdb68dfb9a32140b6a6777a0)
- GitHub tag archive SHA-256 `d5875acad2479817b35b2031dc1c7c22d100f45c7f3c9f6039cb217437a298a2`
- MIT license in [LICENSE.md](LICENSE.md)

| Upstream files in this project | Role |
|---|---|
| `Source/tasks.c`, `Source/list.c` | Task scheduling and notifications, kernel lists |
| `Source/queue.c` | Queue implementation used by the 0-3C-3 event producer and consumer |
| `include/` | Upstream kernel headers |
| `portable/RVDS/ARM_CM3/port.c`, `portable/RVDS/ARM_CM3/portmacro.h` | RVDS Cortex-M3 port for ARMCC5 |
| `portable/MemMang/heap_4.c` | Dynamic memory allocator |

These files and `LICENSE.md` match the pinned upstream commit byte for byte. The upstream `tasks.c`, `list.c`, and `queue.c` are stored under `Source/` in this project. Project configuration and hooks are in `Config/`.
