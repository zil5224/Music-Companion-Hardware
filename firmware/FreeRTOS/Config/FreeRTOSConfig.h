#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

#define configCPU_CLOCK_HZ                         8000000UL
#define configTICK_RATE_HZ                         1000U
#define configTICK_TYPE_WIDTH_IN_BITS              TICK_TYPE_WIDTH_32_BITS
#define configUSE_PREEMPTION                       1
#define configUSE_TIME_SLICING                     1
#define configMAX_PRIORITIES                       4
#define configMAX_TASK_NAME_LEN                    18U
#define configMINIMAL_STACK_SIZE                   128U

#define configSUPPORT_DYNAMIC_ALLOCATION           1
#define configSUPPORT_STATIC_ALLOCATION            0
#define configTOTAL_HEAP_SIZE                      5120U
#define configCHECK_FOR_STACK_OVERFLOW             2
#define configUSE_MALLOC_FAILED_HOOK                1

#define configUSE_TIMERS                           0
#define configUSE_TICKLESS_IDLE                    0
#define configUSE_TICK_HOOK                        0
#define configUSE_IDLE_HOOK                        1
#define configUSE_TASK_NOTIFICATIONS               1
#define configQUEUE_REGISTRY_SIZE                  1

#define configPRIO_BITS                            4
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY    15
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5
/* The RVDS port also expands this expression in ARM inline assembly. */
#define configMAX_SYSCALL_INTERRUPT_PRIORITY \
    ( configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << ( 8 - configPRIO_BITS ) )

void ZilyAssertFailed(const char *file, unsigned long line);
#define configASSERT(condition) \
    do { if (!(condition)) { ZilyAssertFailed(__FILE__, __LINE__); } } while (0)

#define INCLUDE_xTaskDelayUntil                    1
#define INCLUDE_eTaskGetState                      1
/* Lets portMAX_DELAY suspend a notification wait indefinitely. */
#define INCLUDE_vTaskSuspend                       1
#define INCLUDE_uxTaskGetStackHighWaterMark        1

#define vPortSVCHandler                            SVC_Handler
#define xPortPendSVHandler                         PendSV_Handler
#define xPortSysTickHandler                        SysTick_Handler

#endif
