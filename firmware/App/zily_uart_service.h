#ifndef ZILY_UART_SERVICE_H
#define ZILY_UART_SERVICE_H

#include <stdint.h>

#define ZILY_UART_NOTIFY_RX_READY    (1UL << 0)
#define ZILY_UART_NOTIFY_RX_OVERFLOW (1UL << 1)
#define ZILY_UART_NOTIFY_RX_ERROR    (1UL << 2)

/* Create once after the other application tasks and before the scheduler. */
void ZilyCreateUartService(void);

/* Used by the malloc-failure hook during optional startup allocation. */
uint8_t ZilyUartServiceIsCreatingTask(void);

#endif
