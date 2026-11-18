#include "zily_display_service.h"

#include <string.h>

#include "zily_oled.h"

/* One staging buffer for the bitmap being transferred. The OLED framebuffer
 * stays owned by the display driver; the region is drawn opaquely at END. */
static uint8_t displayBuffer[ZILY_DISPLAY_MAX_BYTES];

/* Session state. `zilyDisplaySessionActive` and `zilyDisplayNextChunk` double
 * as the Watch variables, so there is no second copy to keep in sync. */
static uint8_t sessionId;
static uint16_t regionX;
static uint16_t regionY;
static uint16_t regionWidth;
static uint16_t regionHeight;
static uint16_t totalBytes;
static uint8_t totalChunks;
static uint16_t receivedBytes;

volatile uint32_t zilyDisplayBeginCount;
volatile uint32_t zilyDisplayDataCount;
volatile uint32_t zilyDisplayEndCount;
volatile uint32_t zilyDisplayErrorCount;
volatile uint32_t zilyDisplayI2cErrorCount;
volatile uint32_t zilyDisplayBytes;
volatile uint8_t zilyDisplayLastStatus;
volatile uint8_t zilyDisplaySessionActive;
volatile uint8_t zilyDisplayNextChunk;

static void SendAck(uint8_t command, uint16_t sequence, uint8_t status,
                    uint8_t nextChunk, ZilyUartSendFrame send)
{
    uint8_t payload[ZILY_DISPLAY_ACK_LENGTH];

    payload[0] = command;
    payload[1] = status;
    payload[2] = nextChunk;
    zilyDisplayLastStatus = status;
    if (status != ZILY_DISPLAY_STATUS_OK)
    {
        ++zilyDisplayErrorCount;
    }
    ZilyUartProtocolSendReply(ZILY_DISPLAY_TYPE_ACK, sequence, payload,
                              (uint16_t)ZILY_DISPLAY_ACK_LENGTH, send);
}

static void ClearSession(void)
{
    zilyDisplaySessionActive = 0U;
    zilyDisplayNextChunk = 0U;
    receivedBytes = 0U;
}

static uint16_t StrideOf(uint16_t width)
{
    return (uint16_t)((width + 7U) / 8U);
}

/* BEGIN payload: session, x, y, width, height, format, totalBytes LE16,
 * totalChunks. An invalid BEGIN leaves the current session untouched. */
static void HandleBegin(uint16_t sequence, const uint8_t *payload, uint16_t length,
                        ZilyUartSendFrame send)
{
    uint16_t x;
    uint16_t y;
    uint16_t width;
    uint16_t height;
    uint16_t bytes;
    uint16_t expectedBytes;
    uint16_t expectedChunks;
    uint8_t session;
    uint8_t format;
    uint8_t chunks;
    uint8_t valid;

    ++zilyDisplayBeginCount;
    if (length != ZILY_DISPLAY_BEGIN_LENGTH)
    {
        SendAck(ZILY_DISPLAY_TYPE_BEGIN, sequence, ZILY_DISPLAY_STATUS_BAD_PAYLOAD,
                0U, send);
        return;
    }

    session = payload[0];
    x = payload[1];
    y = payload[2];
    width = payload[3];
    height = payload[4];
    format = payload[5];
    bytes = (uint16_t)((uint16_t)payload[6] | ((uint16_t)payload[7] << 8U));
    chunks = payload[8];

    valid = (uint8_t)((format == 0U) && (width > 0U) && (height > 0U) &&
                      (width <= ZILY_DISPLAY_WIDTH) && (height <= ZILY_DISPLAY_HEIGHT) &&
                      (x < ZILY_DISPLAY_WIDTH) && (y < ZILY_DISPLAY_HEIGHT) &&
                      ((uint16_t)(x + width) <= ZILY_DISPLAY_WIDTH) &&
                      ((uint16_t)(y + height) <= ZILY_DISPLAY_HEIGHT));
    if (valid != 0U)
    {
        expectedBytes = (uint16_t)(StrideOf(width) * height);
        expectedChunks = (uint16_t)((expectedBytes + (ZILY_DISPLAY_CHUNK_BYTES - 1U)) /
                                    ZILY_DISPLAY_CHUNK_BYTES);
        valid = (uint8_t)((bytes == expectedBytes) &&
                          (bytes <= ZILY_DISPLAY_MAX_BYTES) &&
                          (chunks == expectedChunks) &&
                          (chunks > 0U) && (chunks <= ZILY_DISPLAY_MAX_CHUNKS));
    }
    if (valid == 0U)
    {
        SendAck(ZILY_DISPLAY_TYPE_BEGIN, sequence, ZILY_DISPLAY_STATUS_BAD_PAYLOAD,
                0U, send);
        return;
    }

    sessionId = session;
    regionX = x;
    regionY = y;
    regionWidth = width;
    regionHeight = height;
    totalBytes = bytes;
    totalChunks = chunks;
    receivedBytes = 0U;
    zilyDisplayNextChunk = 0U;
    zilyDisplaySessionActive = 1U;
    SendAck(ZILY_DISPLAY_TYPE_BEGIN, sequence, ZILY_DISPLAY_STATUS_OK, 0U, send);
}

/* DATA payload: session, chunk, offset LE16, bitmap bytes. Offsets and lengths
 * are strict for the fixed 240-byte chunking, so a short or misplaced fragment
 * can never write outside the transferred bitmap. */
static void HandleData(uint16_t sequence, const uint8_t *payload, uint16_t length,
                       ZilyUartSendFrame send)
{
    uint8_t session;
    uint8_t chunk;
    uint16_t offset;
    uint16_t dataLength;
    uint16_t expectedOffset;
    uint16_t expectedLength;

    ++zilyDisplayDataCount;
    if (length < ZILY_DISPLAY_DATA_HEADER_LENGTH)
    {
        SendAck(ZILY_DISPLAY_TYPE_DATA, sequence, ZILY_DISPLAY_STATUS_BAD_PAYLOAD,
                zilyDisplaySessionActive != 0U ? zilyDisplayNextChunk : 0U, send);
        return;
    }

    session = payload[0];
    chunk = payload[1];
    offset = (uint16_t)((uint16_t)payload[2] | ((uint16_t)payload[3] << 8U));
    dataLength = (uint16_t)(length - ZILY_DISPLAY_DATA_HEADER_LENGTH);

    if ((zilyDisplaySessionActive == 0U) || (session != sessionId))
    {
        SendAck(ZILY_DISPLAY_TYPE_DATA, sequence, ZILY_DISPLAY_STATUS_BAD_SESSION,
                0U, send);
        return;
    }

    if ((zilyDisplayNextChunk != 0U) &&
        (chunk == (uint8_t)(zilyDisplayNextChunk - 1U)))
    {
        /* Retransmission of the last accepted chunk: acknowledge without
         * copying, so a duplicate cannot corrupt the staged bitmap. */
        SendAck(ZILY_DISPLAY_TYPE_DATA, sequence, ZILY_DISPLAY_STATUS_OK,
                zilyDisplayNextChunk, send);
        return;
    }
    if (chunk != zilyDisplayNextChunk)
    {
        SendAck(ZILY_DISPLAY_TYPE_DATA, sequence, ZILY_DISPLAY_STATUS_BAD_CHUNK,
                zilyDisplayNextChunk, send);
        return;
    }
    if (chunk >= totalChunks)
    {
        /* Every expected chunk already arrived; refuse the extra one. */
        SendAck(ZILY_DISPLAY_TYPE_DATA, sequence, ZILY_DISPLAY_STATUS_BAD_CHUNK,
                zilyDisplayNextChunk, send);
        return;
    }

    expectedOffset = (uint16_t)((uint16_t)chunk * ZILY_DISPLAY_CHUNK_BYTES);
    expectedLength = (uint16_t)(totalBytes - expectedOffset);
    if (expectedLength > ZILY_DISPLAY_CHUNK_BYTES)
    {
        expectedLength = (uint16_t)ZILY_DISPLAY_CHUNK_BYTES;
    }
    if ((offset != expectedOffset) || (dataLength != expectedLength))
    {
        SendAck(ZILY_DISPLAY_TYPE_DATA, sequence, ZILY_DISPLAY_STATUS_BAD_PAYLOAD,
                zilyDisplayNextChunk, send);
        return;
    }

    memcpy(&displayBuffer[offset], &payload[ZILY_DISPLAY_DATA_HEADER_LENGTH],
           (size_t)dataLength);
    receivedBytes = (uint16_t)(receivedBytes + dataLength);
    zilyDisplayBytes += (uint32_t)dataLength;
    zilyDisplayNextChunk = (uint8_t)(zilyDisplayNextChunk + 1U);
    SendAck(ZILY_DISPLAY_TYPE_DATA, sequence, ZILY_DISPLAY_STATUS_OK,
            zilyDisplayNextChunk, send);
}

/* END payload: session, flags (bit0 = refresh now, V1 fixes the byte to 0x01).
 * A failed draw or refresh keeps the session so the host can retry END: both
 * operations are idempotent for an unchanged staged bitmap. */
static void HandleEnd(uint16_t sequence, const uint8_t *payload, uint16_t length,
                      ZilyUartSendFrame send)
{
    uint8_t session;
    uint8_t flags;
    uint8_t drawn;
    ZilyI2cStatus status;

    ++zilyDisplayEndCount;
    if (length != ZILY_DISPLAY_END_LENGTH)
    {
        SendAck(ZILY_DISPLAY_TYPE_END, sequence, ZILY_DISPLAY_STATUS_BAD_PAYLOAD,
                zilyDisplaySessionActive != 0U ? zilyDisplayNextChunk : 0U, send);
        return;
    }

    session = payload[0];
    flags = payload[1];
    if ((zilyDisplaySessionActive == 0U) || (session != sessionId))
    {
        SendAck(ZILY_DISPLAY_TYPE_END, sequence, ZILY_DISPLAY_STATUS_BAD_SESSION,
                0U, send);
        return;
    }
    if (flags != 0x01U)
    {
        SendAck(ZILY_DISPLAY_TYPE_END, sequence, ZILY_DISPLAY_STATUS_BAD_PAYLOAD,
                zilyDisplayNextChunk, send);
        return;
    }
    if ((zilyDisplayNextChunk != totalChunks) || (receivedBytes != totalBytes))
    {
        ClearSession();
        SendAck(ZILY_DISPLAY_TYPE_END, sequence, ZILY_DISPLAY_STATUS_BAD_PAYLOAD,
                0U, send);
        return;
    }

    drawn = ZILY_OLED_DrawBitmap(regionX, regionY, regionWidth, regionHeight,
                                 displayBuffer, (size_t)totalBytes);
    if (drawn == 0U)
    {
        SendAck(ZILY_DISPLAY_TYPE_END, sequence, ZILY_DISPLAY_STATUS_INTERNAL,
                zilyDisplayNextChunk, send);
        return;
    }
    status = ZILY_OLED_FlushRegion(regionX, regionY, regionWidth, regionHeight);
    if (status != ZILY_I2C_OK)
    {
        ++zilyDisplayI2cErrorCount;
        SendAck(ZILY_DISPLAY_TYPE_END, sequence, ZILY_DISPLAY_STATUS_IO_ERROR,
                zilyDisplayNextChunk, send);
        return;
    }

    ClearSession();
    SendAck(ZILY_DISPLAY_TYPE_END, sequence, ZILY_DISPLAY_STATUS_OK, 0U, send);
}

uint8_t ZilyDisplayHandleCommand(uint8_t type, uint16_t sequence,
                                 const uint8_t *payload, uint16_t length,
                                 ZilyUartSendFrame send)
{
    switch (type)
    {
        case ZILY_DISPLAY_TYPE_BEGIN:
            HandleBegin(sequence, payload, length, send);
            return 1U;
        case ZILY_DISPLAY_TYPE_DATA:
            HandleData(sequence, payload, length, send);
            return 1U;
        case ZILY_DISPLAY_TYPE_END:
            HandleEnd(sequence, payload, length, send);
            return 1U;
        default:
            break;
    }
    if ((type >= ZILY_DISPLAY_TYPE_RESERVED_FIRST) &&
        (type <= ZILY_DISPLAY_TYPE_RESERVED_LAST))
    {
        SendAck(type, sequence, ZILY_DISPLAY_STATUS_UNSUPPORTED, 0U, send);
        return 1U;
    }
    return 0U;
}
