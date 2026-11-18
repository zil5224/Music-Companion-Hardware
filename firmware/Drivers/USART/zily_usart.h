#ifndef ZILY_USART_H
#define ZILY_USART_H

#include <stdint.h>

/* Call after SystemCoreClock has been updated. Configures USART1 TX at
 * 115200 8N1 on PA9 and prepares PA10 as an input with pull-up. */
void ZILY_USART1_Init(void);

/* Polling TX for a single caller after initialization. Each function returns
 * 1 when all requested bytes have left the transmitter, or 0 on timeout or
 * a NULL pointer. A timeout can leave part of the message transmitted.
 * SendData accepts zero length with a non-NULL pointer. SendString requires a
 * NUL-terminated string, omits the terminator, and accepts an empty string. */
uint8_t ZILY_USART1_SendByte(uint8_t data);
uint8_t ZILY_USART1_SendData(const uint8_t *data, uint16_t length);
uint8_t ZILY_USART1_SendString(const char *str);

#endif
