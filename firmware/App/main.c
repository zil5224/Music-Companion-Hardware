#include "stm32f10x.h"

#include "FreeRTOS.h"
#include "task.h"

#include "zily_oled.h"
#include "zily_oled_demo.h"
#include "zily_uart_service.h"
#include "zily_usart.h"

#include "zily_encoder.h"
#include "zily_key.h"

/* Set to 1 to run the panel bring-up pattern test at boot instead of the
 * normal startup. The test blocks for about 2 seconds and leaves the test
 * screen on the panel, so keep it disabled for normal use. */
#ifndef ZILY_BOOT_SELFTEST
#define ZILY_BOOT_SELFTEST 0
#endif

#if configPRIO_BITS != __NVIC_PRIO_BITS
    #error FreeRTOS priority width must match the STM32F103 device header
#endif

/* Sampled by LED_Task after the scheduler starts. Stack margin is in words. */
volatile UBaseType_t zilyLedStackHighWaterWords;
volatile size_t zilyFreeHeapBytes;
volatile size_t zilyMinFreeHeapBytes;

static void LedTask(void *argument)
{
    TickType_t lastWakeTime = xTaskGetTickCount();
    const TickType_t togglePeriod = pdMS_TO_TICKS(500U);
    uint32_t ledState = GPIO_BSRR_BS12;

    (void)argument;

    for (;;)
    {
        GPIOB->BSRR = ledState;
        ledState = (ledState == GPIO_BSRR_BS12) ? GPIO_BSRR_BR12 : GPIO_BSRR_BS12;

        zilyLedStackHighWaterWords = uxTaskGetStackHighWaterMark(NULL);
        zilyFreeHeapBytes = xPortGetFreeHeapSize();
        zilyMinFreeHeapBytes = xPortGetMinimumEverFreeHeapSize();

        (void)xTaskDelayUntil(&lastWakeTime, togglePeriod);
    }
}

int main(void)
{
    BaseType_t taskCreated;

    SystemCoreClockUpdate();
    configASSERT((RCC->CFGR & RCC_CFGR_SWS) == RCC_CFGR_SWS_HSI);
    configASSERT(SystemCoreClock == configCPU_CLOCK_HZ);

    /* AIRCR.PRIGROUP=3 gives four preemption bits and zero subpriority bits. */
    NVIC_SetPriorityGrouping(3U);
    configASSERT(NVIC_GetPriorityGrouping() == 3U);

    RCC->APB2ENR |= RCC_APB2ENR_IOPBEN;
    (void)RCC->APB2ENR;

    /* Preload PB12 low, then select general-purpose push-pull at 2 MHz. */
    GPIOB->BSRR = GPIO_BSRR_BR12;
    GPIOB->CRH = (GPIOB->CRH & ~(GPIO_CRH_CNF12 | GPIO_CRH_MODE12)) |
                 GPIO_CRH_MODE12_1;

    /* 0-9A physical input: pulled-up encoder push button and the TIM3 encoder
     * interface. The UART service task samples them at 10 ms and sends
     * 0xC0/0xC1 events. */
    ZILY_KEY_Init();
    ZILY_ENCODER_Init();

    /* Bring the panel up before the host can push frames. The optional
     * self-test initializes the panel itself and then runs the pattern test. */
#if ZILY_BOOT_SELFTEST
    ZilyOledRunStartupTest();
#else
    (void)ZILY_OLED_Init();
#endif

    ZILY_USART1_Init();
    /* Start the scheduler even if the one-time startup message times out. */
    (void)ZILY_USART1_SendString("ZILY UART1 READY\r\n");

    taskCreated = xTaskCreate(LedTask, "LED_Task", 192U, NULL, 1U, NULL);
    configASSERT(taskCreated == pdPASS);

    ZilyCreateUartService();
    vTaskStartScheduler();

    /* A running scheduler does not return here. */
    configASSERT(0);
}
