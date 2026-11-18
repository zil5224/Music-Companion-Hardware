#ifndef ZILY_DISPLAY_SERVICE_H
#define ZILY_DISPLAY_SERVICE_H

#include <stdint.h>

#include "zily_uart_protocol.h"

/* 0-8A display transfer TYPEs. BEGIN/DATA/END are requests, ACK is the reply.
 * The display class sits between the frozen 0-4C/0-7A ranges (0x01-0x04,
 * 0x10-0x13, 0x90) and the physical-key event range (0xC0-0xEF). */
#define ZILY_DISPLAY_TYPE_BEGIN           0x40U
#define ZILY_DISPLAY_TYPE_DATA            0x41U
#define ZILY_DISPLAY_TYPE_END             0x42U
#define ZILY_DISPLAY_TYPE_ACK             0x91U
/* 0x43 stays reserved and silent. 0x44-0x4F are reserved display types and
 * answer DISPLAY_ACK with STATUS=UNSUPPORTED so the host learns the class. */
#define ZILY_DISPLAY_TYPE_RESERVED_FIRST  0x44U
#define ZILY_DISPLAY_TYPE_RESERVED_LAST   0x4FU

/* STATUS byte carried by DISPLAY_ACK, payload [CMD, STATUS, NEXT_CHUNK]. */
#define ZILY_DISPLAY_STATUS_OK            0x00U
#define ZILY_DISPLAY_STATUS_UNSUPPORTED   0x01U
#define ZILY_DISPLAY_STATUS_BAD_PAYLOAD   0x02U
#define ZILY_DISPLAY_STATUS_BAD_SESSION   0x03U
#define ZILY_DISPLAY_STATUS_BAD_CHUNK     0x04U
#define ZILY_DISPLAY_STATUS_BUSY          0x05U
#define ZILY_DISPLAY_STATUS_INTERNAL      0x06U
#define ZILY_DISPLAY_STATUS_IO_ERROR      0x07U

/* Fixed V1 transfer geometry. Chunks are 240 bitmap bytes, so the largest DATA
 * frame is 4 + 240 = 244 payload bytes (254 bytes on the wire). */
#define ZILY_DISPLAY_CHUNK_BYTES          240U
#define ZILY_DISPLAY_MAX_BYTES            1024U
#define ZILY_DISPLAY_MAX_CHUNKS           5U
#define ZILY_DISPLAY_BEGIN_LENGTH         9U
#define ZILY_DISPLAY_DATA_HEADER_LENGTH   4U
#define ZILY_DISPLAY_END_LENGTH           2U
#define ZILY_DISPLAY_ACK_LENGTH           3U

/* Handles one 0x40-0x42 or 0x44-0x4F request and always emits exactly one ACK
 * through `send`. Returns 1 when the TYPE belongs to the display class, 0 when
 * it does not (the caller keeps its existing unknown-TYPE behaviour).
 *
 * Runs in the UART service task only. END performs the synchronous
 * DrawBitmap + FlushRegion, so the caller sees the full I2C refresh inside this
 * call. No dynamic allocation and no blocking API are used. */
uint8_t ZilyDisplayHandleCommand(uint8_t type, uint16_t sequence,
                                 const uint8_t *payload, uint16_t length,
                                 ZilyUartSendFrame send);

/* Watch variables. Only the UART service task writes them in V1. Frame counters
 * count every frame handled, including rejected ones. */
extern volatile uint32_t zilyDisplayBeginCount;
extern volatile uint32_t zilyDisplayDataCount;
extern volatile uint32_t zilyDisplayEndCount;
extern volatile uint32_t zilyDisplayErrorCount;
extern volatile uint32_t zilyDisplayI2cErrorCount;
extern volatile uint32_t zilyDisplayBytes;
extern volatile uint8_t zilyDisplayLastStatus;
/* Current session, exposed for Watch only. */
extern volatile uint8_t zilyDisplaySessionActive;
extern volatile uint8_t zilyDisplayNextChunk;

#endif
