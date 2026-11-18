#ifndef ZILY_UART_PROTOCOL_H
#define ZILY_UART_PROTOCOL_H

#include <stdint.h>

/* 0-9A physical input events (STM32 -> PC, unsolicited, no ACK).
 *   KEY_EVENT     LEN=2: [keyId, action]
 *                 keyId  1=KEY1, 2=KEY2, 3=encoder push
 *                 action 0=short press, 1=long press
 *   ENCODER_EVENT LEN=1: [int8 detent delta]  (+ clockwise, - counter-clockwise)
 * Event frames use SEQ=0 and never receive an ACK. The host answer range
 * 0x80-0x8F stays reserved but unused in V1. */
#define ZILY_UART_EVENT_KEY        0xC0U
#define ZILY_UART_EVENT_ENCODER    0xC1U
#define ZILY_UART_EVENT_FIRST      0xC0U
#define ZILY_UART_EVENT_LAST       0xEFU

typedef uint8_t (*ZilyUartSendFrame)(const uint8_t *data, uint16_t length);

/* The UART task owns this parser. The send callback completes synchronously. */
void ZilyUartProtocolReceiveByte(uint8_t data, ZilyUartSendFrame send);
uint8_t ZilyUartProtocolHasPendingFrame(void);
void ZilyUartProtocolExpire(ZilyUartSendFrame send);
void ZilyUartProtocolReset(void);

uint16_t ZilyUartProtocolCrc16(const uint8_t *data, uint16_t length);

/* Emit one reply frame on behalf of a command handler that lives outside this
 * file (the 0-8A display service). It reuses the same static txFrame and
 * synchronous send callback as the internal replies, so it must be called from
 * the UART service task only. Lengths above 256 are ignored. */
void ZilyUartProtocolSendReply(uint8_t type, uint16_t sequence,
                               const uint8_t *payload, uint16_t length,
                               ZilyUartSendFrame send);

/* Emit one unsolicited device event in the 0xC0-0xEF range. SEQ is 0 and no
 * ACK is expected. Reuses the same static txFrame as the replies, so it must
 * run in the UART service task only. Returns 1 when the frame was sent and 0
 * for a rejected type/payload or a send failure. */
uint8_t ZilyUartProtocolSendEvent(uint8_t type, const uint8_t *payload,
                                  uint16_t length, ZilyUartSendFrame send);

extern volatile uint32_t zilyUartValidFrameCount;
extern volatile uint32_t zilyUartCrcErrorCount;
extern volatile uint32_t zilyUartFrameFormatErrorCount;
extern volatile uint32_t zilyUartFrameLengthErrorCount;
extern volatile uint32_t zilyUartUnsupportedTypeCount;
extern volatile uint32_t zilyUartPingCount;
extern volatile uint32_t zilyUartEchoCount;
extern volatile uint32_t zilyUartAppCommandCount;
extern volatile uint32_t zilyUartAppNackCount;
extern volatile uint32_t zilyUartTxFrameCount;
extern volatile uint32_t zilyUartTxErrorCount;
extern volatile uint32_t zilyUartProtocolResetCount;
extern volatile uint32_t zilyUartFrameTimeoutCount;
extern volatile uint32_t zilyUartEventFrameCount;
extern volatile uint32_t zilyUartEventTypeErrorCount;

#endif
