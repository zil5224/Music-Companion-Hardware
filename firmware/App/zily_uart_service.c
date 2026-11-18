#include "zily_uart_service.h"

#include "stm32f10x.h"

#include "FreeRTOS.h"
#include "task.h"

#include "zily_uart_protocol.h"
#include "zily_usart.h"

#include "zily_encoder.h"
#include "zily_input_service.h"
#include "zily_key.h"

#define ZILY_UART_RX_BUFFER_SIZE 512U
#define ZILY_UART_RX_BUFFER_MASK 511U
#define ZILY_UART_TASK_PRIORITY  3U
#define ZILY_UART_STACK_WORDS    192U
#define ZILY_UART_FRAME_IDLE_MS  100U
#define ZILY_UART_RX_ERRORS      (USART_SR_ORE | USART_SR_FE | USART_SR_NE | USART_SR_PE)

#if ZILY_UART_TASK_PRIORITY >= configMAX_PRIORITIES
    #error UART service task priority is outside the FreeRTOS range
#endif

static volatile uint8_t rxBuffer[ZILY_UART_RX_BUFFER_SIZE];
static volatile uint16_t rxHead;
static volatile uint16_t rxTail;
static volatile uint16_t rxLossHead;
static volatile uint8_t rxLossPending;
static TaskHandle_t xUartServiceTaskHandle;
static volatile uint8_t uartTaskCreateInProgress;

/* 0-9A adapters: the input service owns debounce/long-press/detent logic and
 * only sees these two contracts. Events are sent on the same static txFrame as
 * replies, from the UART service task context. */
static uint8_t InputReadEncoderPush(void)
{
    return ZILY_KEY_IsEncoderPushPressed();
}

static int16_t InputReadEncoderDelta(void)
{
    return ZILY_ENCODER_TakeDelta();
}

static uint8_t InputSendKey(uint8_t keyId, uint8_t action)
{
    uint8_t payload[2];

    payload[0] = keyId;
    payload[1] = action;

    return ZilyUartProtocolSendEvent(ZILY_UART_EVENT_KEY, payload,
                                     (uint16_t)sizeof(payload),
                                     ZILY_USART1_SendData);
}

static uint8_t InputSendEncoder(int8_t steps)
{
    uint8_t payload[1];

    payload[0] = (uint8_t)steps;

    return ZilyUartProtocolSendEvent(ZILY_UART_EVENT_ENCODER, payload,
                                     (uint16_t)sizeof(payload),
                                     ZILY_USART1_SendData);
}

static const ZilyInputHardware inputHardware = {
    InputReadEncoderPush,
    InputReadEncoderDelta
};

static const ZilyInputSink inputSink = {
    InputSendKey,
    InputSendEncoder
};

/* ISR counters. ISR byte count includes discarded data when RXNE was set. */
volatile uint32_t zilyUartRxIsrByteCount;
volatile uint32_t zilyUartRxEnqueuedByteCount;
volatile uint32_t zilyUartRxOverflowCount;
volatile uint32_t zilyUartRxErrorCount;
volatile uint32_t zilyUartRxOverrunCount;
volatile uint32_t zilyUartRxFramingErrorCount;
volatile uint32_t zilyUartRxNoiseErrorCount;
volatile uint32_t zilyUartRxParityErrorCount;

/* Task counters and sticky loss flags. Last byte refers to a consumed byte. */
volatile uint32_t zilyUartRxTaskByteCount;
volatile uint32_t zilyUartTaskWakeCount;
volatile uint32_t zilyUartRxEventFlags;
volatile UBaseType_t zilyUartTaskStackHighWaterWords;
volatile size_t zilyUartServiceFreeHeapBytes;
volatile uint8_t zilyUartLastRxByte;
volatile uint8_t zilyUartServiceCreateFailed;

void USART1_IRQHandler(void)
{
    const uint32_t status = USART1->SR;
    const uint32_t errors = status & ZILY_UART_RX_ERRORS;
    BaseType_t higherPriorityTaskWoken = pdFALSE;
    uint32_t notificationBits;
    uint8_t data;

    if ((status & (USART_SR_RXNE | ZILY_UART_RX_ERRORS)) == 0U)
    {
        return;
    }

    /* Read DR after SR to clear RXNE and the receive error flags. */
    data = (uint8_t)USART1->DR;
    if ((status & USART_SR_RXNE) != 0U)
    {
        ++zilyUartRxIsrByteCount;
    }

    if (errors != 0U)
    {
        ++zilyUartRxErrorCount;
        zilyUartRxOverrunCount += (errors & USART_SR_ORE) != 0U;
        zilyUartRxFramingErrorCount += (errors & USART_SR_FE) != 0U;
        zilyUartRxNoiseErrorCount += (errors & USART_SR_NE) != 0U;
        zilyUartRxParityErrorCount += (errors & USART_SR_PE) != 0U;
        notificationBits = ZILY_UART_NOTIFY_RX_ERROR;
    }
    else
    {
        const uint16_t head = rxHead;
        const uint16_t next = (uint16_t)((head + 1U) & ZILY_UART_RX_BUFFER_MASK);

        if (next == rxTail)
        {
            ++zilyUartRxOverflowCount;
            notificationBits = ZILY_UART_NOTIFY_RX_OVERFLOW;
        }
        else
        {
            rxBuffer[head] = data;
            __DMB();
            rxHead = next;
            ++zilyUartRxEnqueuedByteCount;
            notificationBits = ZILY_UART_NOTIFY_RX_READY;
        }
    }

    if (notificationBits != ZILY_UART_NOTIFY_RX_READY)
    {
        rxLossHead = rxHead;
        rxLossPending = 1U;
    }

    (void)xTaskNotifyFromISR(xUartServiceTaskHandle, notificationBits,
                            eSetBits, &higherPriorityTaskWoken);
    portYIELD_FROM_ISR(higherPriorityTaskWoken);
}

static void UART_ServiceTask(void *argument)
{
    const TickType_t statsPeriod = pdMS_TO_TICKS(100U);
    TickType_t lastSample = xTaskGetTickCount();
    uint32_t notificationBits;

    (void)argument;

    /* TX initialization is complete. Enable RX only from the running task,
     * after clearing any stale peripheral status and NVIC pending state. */
    (void)USART1->SR;
    (void)USART1->DR;
    NVIC_SetPriority(USART1_IRQn, configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY);
    NVIC_ClearPendingIRQ(USART1_IRQn);
    USART1->CR3 |= USART_CR3_EIE;
    USART1->CR1 |= USART_CR1_RE | USART_CR1_RXNEIE | USART_CR1_PEIE;
    NVIC_EnableIRQ(USART1_IRQn);

    zilyUartServiceFreeHeapBytes = xPortGetFreeHeapSize();
    for (;;)
    {
        /* A pending partial frame keeps its 100 ms idle timeout. Otherwise wake
         * up at the 10 ms input cadence; the input service time-gates samples,
         * so extra wakeups caused by incoming bytes are harmless. */
        const TickType_t wait = (ZilyUartProtocolHasPendingFrame() != 0U) ?
                               pdMS_TO_TICKS(ZILY_UART_FRAME_IDLE_MS) :
                               pdMS_TO_TICKS(ZILY_INPUT_POLL_MS);
        const BaseType_t notified = xTaskNotifyWait(0U, UINT32_MAX, &notificationBits, wait);
        TickType_t now;

        if (notified == pdTRUE)
        {
            ++zilyUartTaskWakeCount;
            zilyUartRxEventFlags |= notificationBits &
                (ZILY_UART_NOTIFY_RX_OVERFLOW | ZILY_UART_NOTIFY_RX_ERROR);
        }
        else if (rxLossPending == 0U)
        {
            ZilyUartProtocolExpire(ZILY_USART1_SendData);
        }

        for (;;)
        {
            /* Read head before loss state. Bytes published after a loss cannot
             * enter this snapshot without making that loss visible here. */
            const uint16_t head = rxHead;
            const uint16_t tail = rxTail;
            uint8_t data;

            if (rxLossPending != 0U)
            {
                /* Snapshot the latest gap and acknowledge it atomically with
                 * respect to USART1. Keep any bytes queued after that gap. */
                taskENTER_CRITICAL();
                rxTail = rxLossHead;
                rxLossPending = 0U;
                taskEXIT_CRITICAL();
                ZilyUartProtocolReset();
                continue;
            }
            if (tail == head)
            {
                break;
            }

            __DMB();
            data = rxBuffer[tail];
            zilyUartLastRxByte = data;
            ++zilyUartRxTaskByteCount;
            __DMB();
            rxTail = (uint16_t)((tail + 1U) & ZILY_UART_RX_BUFFER_MASK);
            ZilyUartProtocolReceiveByte(data, ZILY_USART1_SendData);
        }

        /* Physical input: debounced keys, long press and encoder detents. The
         * finished events are sent as 0xC0/0xC1 frames on this task's tx path. */
        ZilyInputServicePoll((uint32_t)xTaskGetTickCount());

        /* Stack scanning is useful in Watch but costly on every byte. */
        now = xTaskGetTickCount();
        if ((zilyUartTaskWakeCount == 1U) || ((now - lastSample) >= statsPeriod))
        {
            lastSample = now;
            zilyUartTaskStackHighWaterWords = uxTaskGetStackHighWaterMark(NULL);
            zilyUartServiceFreeHeapBytes = xPortGetFreeHeapSize();
        }
    }
}

/* For this heap_4 port a block header occupies one alignment unit. The public
 * StaticTask_t matches the kernel TCB size even with static allocation off. */
static size_t TaskHeapBytes(size_t stackWords)
{
    const size_t stackBytes = stackWords * sizeof(StackType_t);
    const size_t alignedStack = (stackBytes + portBYTE_ALIGNMENT_MASK) &
                                ~(size_t)portBYTE_ALIGNMENT_MASK;
    const size_t alignedTcb = (sizeof(StaticTask_t) + portBYTE_ALIGNMENT_MASK) &
                              ~(size_t)portBYTE_ALIGNMENT_MASK;

    return alignedStack + alignedTcb + 2U * portBYTE_ALIGNMENT;
}

void ZilyCreateUartService(void)
{
    HeapStats_t heapStats;
    BaseType_t created;

    /* The drivers are initialized in main before this call. Installing the
     * contracts here keeps the hardware/sink wiring next to the task that owns
     * the event TX path. */
    ZilyInputServiceInit(&inputHardware, &inputSink);

    /* The scheduler still needs to allocate the Idle task. At startup all
     * required allocations fit if one free block can hold both tasks. */
    vPortGetHeapStats(&heapStats);
    if (heapStats.xSizeOfLargestFreeBlockInBytes <
        TaskHeapBytes(ZILY_UART_STACK_WORDS) + TaskHeapBytes(configMINIMAL_STACK_SIZE))
    {
        zilyUartServiceCreateFailed = 1U;
        return;
    }

    uartTaskCreateInProgress = 1U;
    created = xTaskCreate(UART_ServiceTask, "UART_ServiceTask", ZILY_UART_STACK_WORDS,
                          NULL, ZILY_UART_TASK_PRIORITY, &xUartServiceTaskHandle);
    uartTaskCreateInProgress = 0U;
    zilyUartServiceCreateFailed = (created != pdPASS);
}

uint8_t ZilyUartServiceIsCreatingTask(void)
{
    return uartTaskCreateInProgress;
}
