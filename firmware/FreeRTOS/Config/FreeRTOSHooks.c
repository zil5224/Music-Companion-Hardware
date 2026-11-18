#include "stm32f10x.h"

#include "FreeRTOS.h"
#include "task.h"

#include "../../App/zily_uart_service.h"

/* Debugger-visible fault context and idle activity. */
volatile uint32_t zilyFaultReason;
const char * volatile zilyAssertFile;
volatile unsigned long zilyAssertLine;
TaskHandle_t volatile zilyOverflowTask;
const char * volatile zilyOverflowTaskName;
volatile uint32_t zilyIdleCount;

static void StopOnFault(uint32_t reason)
{
    __disable_irq();
    zilyFaultReason = reason;

    /* Break only when a debugger is attached. Otherwise preserve the fault state. */
    if ((CoreDebug->DHCSR & CoreDebug_DHCSR_C_DEBUGEN_Msk) != 0U)
    {
        __BKPT(0);
    }
    for (;;)
    {
    }
}

void ZilyAssertFailed(const char *file, unsigned long line)
{
    zilyAssertFile = file;
    zilyAssertLine = line;
    StopOnFault(1U);
}

void vApplicationStackOverflowHook(TaskHandle_t task, char *taskName)
{
    zilyOverflowTask = task;
    zilyOverflowTaskName = taskName;
    StopOnFault(2U);
}

void vApplicationMallocFailedHook(void)
{
    /* Allow xTaskCreate to report failure for the optional UART task. */
    if (ZilyUartServiceIsCreatingTask() != 0U)
    {
        return;
    }

    StopOnFault(3U);
}

void vApplicationIdleHook(void)
{
    ++zilyIdleCount;
}
