#include "zily_uart_protocol.h"

#include "zily_display_service.h"
#include "zily_oled.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Host-side test for the 0-8A display service. Frames enter through the real
 * UART protocol parser and DISPLAY_ACK frames leave through the real reply
 * encoder; only the OLED transfer is stubbed, so geometry, chunk accounting and
 * error mapping are exercised end to end. All frames are built with an
 * independent bitwise CRC reference. */

#define REPLY_CAPACITY 32
#define FRAME_CAPACITY 266

static uint8_t replies[REPLY_CAPACITY][FRAME_CAPACITY];
static uint16_t replyLengths[REPLY_CAPACITY];
static unsigned int replyCount;
static uint8_t sendResult = 1U;

static unsigned int drawCalls;
static unsigned int flushCalls;
static uint16_t drawX;
static uint16_t drawY;
static uint16_t drawWidth;
static uint16_t drawHeight;
static size_t drawLength;
static uint8_t drawData[1024];
static uint16_t flushX;
static uint16_t flushY;
static uint16_t flushWidth;
static uint16_t flushHeight;
static uint8_t drawResult = 1U;
static ZilyI2cStatus flushResult = ZILY_I2C_OK;

uint8_t ZILY_OLED_DrawBitmap(uint16_t x, uint16_t y, uint16_t width,
                            uint16_t height, const uint8_t *data, size_t length)
{
    ++drawCalls;
    drawX = x;
    drawY = y;
    drawWidth = width;
    drawHeight = height;
    drawLength = length;
    if ((data != NULL) && (length <= sizeof(drawData)))
    {
        memcpy(drawData, data, length);
    }
    return drawResult;
}

ZilyI2cStatus ZILY_OLED_FlushRegion(uint16_t x, uint16_t y,
                                   uint16_t width, uint16_t height)
{
    ++flushCalls;
    flushX = x;
    flushY = y;
    flushWidth = width;
    flushHeight = height;
    return flushResult;
}

static uint8_t CaptureReply(const uint8_t *data, uint16_t length)
{
    assert(replyCount < REPLY_CAPACITY);
    assert(length <= FRAME_CAPACITY);
    memcpy(replies[replyCount], data, length);
    replyLengths[replyCount++] = length;
    return sendResult;
}

static void Feed(const uint8_t *bytes, size_t length)
{
    size_t i;

    for (i = 0; i < length; ++i)
    {
        ZilyUartProtocolReceiveByte(bytes[i], CaptureReply);
    }
}

static uint16_t ReferenceCrc(const uint8_t *data, uint16_t length)
{
    uint16_t crc = 0xFFFFU;
    uint16_t i;
    unsigned int bit;

    for (i = 0; i < length; ++i)
    {
        crc ^= (uint16_t)(data[i] << 8U);
        for (bit = 0; bit < 8U; ++bit)
        {
            const uint16_t polynomial = (crc & 0x8000U) ? 0x1021U : 0U;
            crc = (uint16_t)((crc << 1U) ^ polynomial);
        }
    }
    return crc;
}

static void WriteReferenceCrc(uint8_t *frame, uint16_t frameLength)
{
    const uint16_t crc = ReferenceCrc(&frame[2], (uint16_t)(frameLength - 4U));
    frame[frameLength - 2U] = (uint8_t)crc;
    frame[frameLength - 1U] = (uint8_t)(crc >> 8U);
}

static uint16_t MakeFrame(uint8_t *frame, uint8_t type, uint16_t sequence,
                          const uint8_t *payload, uint16_t length)
{
    const uint16_t frameLength = (uint16_t)(10U + length);

    frame[0] = 0xA5U;
    frame[1] = 0x5AU;
    frame[2] = 1U;
    frame[3] = type;
    frame[4] = (uint8_t)sequence;
    frame[5] = (uint8_t)(sequence >> 8U);
    frame[6] = (uint8_t)length;
    frame[7] = (uint8_t)(length >> 8U);
    if (length != 0U)
    {
        memcpy(&frame[8], payload, length);
    }
    WriteReferenceCrc(frame, frameLength);
    return frameLength;
}

static void ResetOled(void)
{
    drawCalls = 0U;
    flushCalls = 0U;
    drawX = drawY = drawWidth = drawHeight = 0U;
    drawLength = 0U;
    memset(drawData, 0, sizeof(drawData));
    flushX = flushY = flushWidth = flushHeight = 0U;
    drawResult = 1U;
    flushResult = ZILY_I2C_OK;
}

static void ResetReplies(void)
{
    replyCount = 0U;
}

static void CheckReply(unsigned int index, const uint8_t *expected, size_t length)
{
    assert(index < replyCount);
    if ((replyLengths[index] != length) ||
        (memcmp(replies[index], expected, length) != 0))
    {
        size_t i;

        fprintf(stderr, "reply %u mismatch, got %u bytes, expected %u bytes\n", index,
                (unsigned int)replyLengths[index], (unsigned int)length);
        for (i = 0; i < replyLengths[index]; ++i)
        {
            fprintf(stderr, "%02X ", replies[index][i]);
        }
        fprintf(stderr, "\n");
        for (i = 0; i < length; ++i)
        {
            fprintf(stderr, "%02X ", expected[i]);
        }
        fprintf(stderr, "\n");
    }
    assert(replyLengths[index] == length);
    assert(memcmp(replies[index], expected, length) == 0);
}

static void CheckAck(unsigned int index, uint8_t command, uint16_t sequence,
                     uint8_t status, uint8_t nextChunk)
{
    uint8_t payload[ZILY_DISPLAY_ACK_LENGTH];
    uint8_t expected[FRAME_CAPACITY];

    payload[0] = command;
    payload[1] = status;
    payload[2] = nextChunk;
    MakeFrame(expected, ZILY_DISPLAY_TYPE_ACK, sequence, payload,
              (uint16_t)ZILY_DISPLAY_ACK_LENGTH);
    CheckReply(index, expected, (size_t)(10U + ZILY_DISPLAY_ACK_LENGTH));
    assert(zilyDisplayLastStatus == status);
}

static void SendDisplay(uint8_t type, uint16_t sequence, const uint8_t *payload,
                        uint16_t length)
{
    uint8_t frame[FRAME_CAPACITY];
    const uint16_t frameLength = MakeFrame(frame, type, sequence, payload, length);

    Feed(frame, frameLength);
}

static void BeginRegion(uint16_t sequence, uint8_t session, uint8_t x, uint8_t y,
                        uint8_t width, uint8_t height)
{
    uint8_t payload[ZILY_DISPLAY_BEGIN_LENGTH];
    const uint16_t stride = (uint16_t)((width + 7U) / 8U);
    const uint16_t bytes = (uint16_t)(stride * height);
    const uint8_t chunks = (uint8_t)((bytes + (ZILY_DISPLAY_CHUNK_BYTES - 1U)) /
                                     ZILY_DISPLAY_CHUNK_BYTES);

    payload[0] = session;
    payload[1] = x;
    payload[2] = y;
    payload[3] = width;
    payload[4] = height;
    payload[5] = 0U;
    payload[6] = (uint8_t)bytes;
    payload[7] = (uint8_t)(bytes >> 8U);
    payload[8] = chunks;
    SendDisplay(ZILY_DISPLAY_TYPE_BEGIN, sequence, payload,
                (uint16_t)ZILY_DISPLAY_BEGIN_LENGTH);
}

static void BeginFullScreen(uint16_t sequence, uint8_t session)
{
    BeginRegion(sequence, session, 0U, 0U, ZILY_DISPLAY_WIDTH, ZILY_DISPLAY_HEIGHT);
}

/* One DATA frame whose payload covers the whole 240-byte chunk unless `count`
 * asks for less (the last, short chunk). Returns the offset of the first byte. */
static uint16_t SendChunk(uint16_t sequence, uint8_t session, uint8_t chunk,
                          const uint8_t *data, uint16_t count)
{
    uint8_t payload[ZILY_DISPLAY_DATA_HEADER_LENGTH + ZILY_DISPLAY_CHUNK_BYTES];
    const uint16_t offset = (uint16_t)((uint16_t)chunk * ZILY_DISPLAY_CHUNK_BYTES);

    payload[0] = session;
    payload[1] = chunk;
    payload[2] = (uint8_t)offset;
    payload[3] = (uint8_t)(offset >> 8U);
    memcpy(&payload[ZILY_DISPLAY_DATA_HEADER_LENGTH], data, count);
    SendDisplay(ZILY_DISPLAY_TYPE_DATA, sequence, payload,
                (uint16_t)(ZILY_DISPLAY_DATA_HEADER_LENGTH + count));
    return offset;
}

static void EndTransfer(uint16_t sequence, uint8_t session, uint8_t flags)
{
    const uint8_t payload[ZILY_DISPLAY_END_LENGTH] = {session, flags};

    SendDisplay(ZILY_DISPLAY_TYPE_END, sequence, payload,
                (uint16_t)ZILY_DISPLAY_END_LENGTH);
}

/* The eight golden frames from section 14 of the protocol document: a 16x8
 * region at (0,56) with session 7, one 16-byte chunk, SEQ 1..3. */
static void TestDocumentGoldenVectors(void)
{
    static const uint8_t beginFrame[] =
        {0xA5, 0x5A, 1, 0x40, 1, 0, 9, 0, 7, 0, 0x38, 0x10, 0x08, 0, 0x10, 0, 1, 0x44, 0xC4};
    static const uint8_t dataFrame[] =
        {0xA5, 0x5A, 1, 0x41, 2, 0, 0x14, 0, 7, 0, 0, 0,
         0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0,
         0xFF, 0xFF, 0, 0, 0x9E, 0x11};
    static const uint8_t endFrame[] = {0xA5, 0x5A, 1, 0x42, 3, 0, 2, 0, 7, 1, 0xDC, 0x61};
    static const uint8_t beginAck[] =
        {0xA5, 0x5A, 1, 0x91, 1, 0, 3, 0, 0x40, 0, 0, 0xA9, 0x3F};
    static const uint8_t dataAck[] =
        {0xA5, 0x5A, 1, 0x91, 2, 0, 3, 0, 0x41, 0, 1, 0x3A, 0xC0};
    static const uint8_t endAck[] =
        {0xA5, 0x5A, 1, 0x91, 3, 0, 3, 0, 0x42, 0, 0, 0x2A, 0x31};
    static const uint8_t expectedBitmap[16] =
        {0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0, 0xFF, 0xFF, 0, 0};
    const uint32_t bytesBefore = zilyDisplayBytes;

    assert(ReferenceCrc(&beginFrame[2], 15U) == 0xC444U);
    assert(ReferenceCrc(&dataFrame[2], 26U) == 0x119EU);
    assert(ReferenceCrc(&endFrame[2], 8U) == 0x61DCU);

    ResetReplies();
    ResetOled();
    Feed(beginFrame, sizeof(beginFrame));
    assert(replyCount == 1U);
    CheckReply(0, beginAck, sizeof(beginAck));
    Feed(dataFrame, sizeof(dataFrame));
    assert(replyCount == 2U);
    CheckReply(1, dataAck, sizeof(dataAck));
    Feed(endFrame, sizeof(endFrame));
    assert(replyCount == 3U);
    CheckReply(2, endAck, sizeof(endAck));

    assert(drawCalls == 1U && flushCalls == 1U);
    assert(drawX == 0U && drawY == 56U && drawWidth == 16U && drawHeight == 8U);
    assert(drawLength == sizeof(expectedBitmap));
    assert(memcmp(drawData, expectedBitmap, sizeof(expectedBitmap)) == 0);
    assert(flushX == 0U && flushY == 56U && flushWidth == 16U && flushHeight == 8U);
    assert(zilyDisplayBytes == bytesBefore + 16U);
    assert(zilyDisplaySessionActive == 0U);
}

/* Full 128x64 screen: five chunks, strict offsets, one draw and one flush. */
static void TestFullScreenUpdate(void)
{
    uint8_t expected[1024];
    uint8_t chunkData[240];
    uint16_t chunk;
    uint16_t index;
    const uint32_t endsBefore = zilyDisplayEndCount;

    for (index = 0U; index < 1024U; ++index)
    {
        expected[index] = (uint8_t)(index * 31U + 7U);
    }

    ResetReplies();
    ResetOled();
    BeginFullScreen(10U, 3U);
    assert(replyCount == 1U);
    CheckAck(0U, ZILY_DISPLAY_TYPE_BEGIN, 10U, ZILY_DISPLAY_STATUS_OK, 0U);
    assert(zilyDisplaySessionActive == 1U && zilyDisplayNextChunk == 0U);

    for (chunk = 0U; chunk < ZILY_DISPLAY_MAX_CHUNKS; ++chunk)
    {
        const uint16_t offset = (uint16_t)(chunk * ZILY_DISPLAY_CHUNK_BYTES);
        uint16_t count = (uint16_t)(1024U - offset);

        if (count > ZILY_DISPLAY_CHUNK_BYTES)
        {
            count = (uint16_t)ZILY_DISPLAY_CHUNK_BYTES;
        }
        memcpy(chunkData, &expected[offset], count);
        SendChunk((uint16_t)(11U + chunk), 3U, (uint8_t)chunk, chunkData, count);
        CheckAck((unsigned int)(1U + chunk), ZILY_DISPLAY_TYPE_DATA,
                 (uint16_t)(11U + chunk), ZILY_DISPLAY_STATUS_OK,
                 (uint8_t)(chunk + 1U));
    }
    assert(zilyDisplayNextChunk == ZILY_DISPLAY_MAX_CHUNKS);

    EndTransfer(16U, 3U, 1U);
    CheckAck(6U, ZILY_DISPLAY_TYPE_END, 16U, ZILY_DISPLAY_STATUS_OK, 0U);
    assert(zilyDisplayEndCount == endsBefore + 1U);
    assert(drawCalls == 1U && flushCalls == 1U);
    assert(drawX == 0U && drawY == 0U && drawWidth == 128U && drawHeight == 64U);
    assert(drawLength == 1024U && memcmp(drawData, expected, 1024U) == 0);
    assert(flushX == 0U && flushY == 0U && flushWidth == 128U && flushHeight == 64U);
    assert(zilyDisplaySessionActive == 0U);
}

/* A duplicate of the last accepted chunk is acknowledged but never copied, and
 * an out-of-order chunk reports the expected index without changing state. */
static void TestDuplicateAndOutOfOrderChunks(void)
{
    uint8_t pattern[240];
    uint8_t duplicate[240];
    uint16_t index;

    for (index = 0U; index < 240U; ++index)
    {
        pattern[index] = (uint8_t)(index + 1U);
        duplicate[index] = 0xAAU;
    }

    ResetReplies();
    ResetOled();
    BeginFullScreen(20U, 4U);
    SendChunk(21U, 4U, 0U, pattern, 240U);
    CheckAck(1U, ZILY_DISPLAY_TYPE_DATA, 21U, ZILY_DISPLAY_STATUS_OK, 1U);

    /* Out-of-order: chunk 2 while chunk 1 is expected. */
    SendChunk(22U, 4U, 2U, pattern, 240U);
    CheckAck(2U, ZILY_DISPLAY_TYPE_DATA, 22U, ZILY_DISPLAY_STATUS_BAD_CHUNK, 1U);
    assert(zilyDisplayNextChunk == 1U);

    /* Duplicate of chunk 0 with different bytes must not overwrite the buffer. */
    SendChunk(23U, 4U, 0U, duplicate, 240U);
    CheckAck(3U, ZILY_DISPLAY_TYPE_DATA, 23U, ZILY_DISPLAY_STATUS_OK, 1U);
    assert(zilyDisplayNextChunk == 1U);

    /* Finish the transfer and confirm the staged chunk 0 is still the original. */
    for (index = 1U; index < ZILY_DISPLAY_MAX_CHUNKS; ++index)
    {
        uint8_t data[240];
        uint16_t count = (uint16_t)(1024U - index * ZILY_DISPLAY_CHUNK_BYTES);

        if (count > ZILY_DISPLAY_CHUNK_BYTES)
        {
            count = (uint16_t)ZILY_DISPLAY_CHUNK_BYTES;
        }
        memset(data, (int)(uint8_t)(0x30U + index), count);
        SendChunk((uint16_t)(24U + index), 4U, (uint8_t)index, data, count);
    }
    EndTransfer(30U, 4U, 1U);
    CheckAck(8U, ZILY_DISPLAY_TYPE_END, 30U, ZILY_DISPLAY_STATUS_OK, 0U);
    assert(drawCalls == 1U);
    assert(memcmp(drawData, pattern, 240U) == 0);
    assert(drawData[240] == 0x31U);
}

/* DATA and END without an active session, or for a different session id. */
static void TestSessionErrors(void)
{
    uint8_t pattern[240];

    memset(pattern, 0xFF, sizeof(pattern));
    ResetReplies();
    ResetOled();

    SendChunk(40U, 5U, 0U, pattern, 240U);
    CheckAck(0U, ZILY_DISPLAY_TYPE_DATA, 40U, ZILY_DISPLAY_STATUS_BAD_SESSION, 0U);
    EndTransfer(41U, 5U, 1U);
    CheckAck(1U, ZILY_DISPLAY_TYPE_END, 41U, ZILY_DISPLAY_STATUS_BAD_SESSION, 0U);
    assert(drawCalls == 0U && flushCalls == 0U);

    BeginFullScreen(42U, 5U);
    CheckAck(2U, ZILY_DISPLAY_TYPE_BEGIN, 42U, ZILY_DISPLAY_STATUS_OK, 0U);
    SendChunk(43U, 6U, 0U, pattern, 240U);
    CheckAck(3U, ZILY_DISPLAY_TYPE_DATA, 43U, ZILY_DISPLAY_STATUS_BAD_SESSION, 0U);
    EndTransfer(44U, 6U, 1U);
    CheckAck(4U, ZILY_DISPLAY_TYPE_END, 44U, ZILY_DISPLAY_STATUS_BAD_SESSION, 0U);
    assert(zilyDisplaySessionActive == 1U && zilyDisplayNextChunk == 0U);

    /* The original session is still usable after the foreign frames. */
    SendChunk(45U, 5U, 0U, pattern, 240U);
    CheckAck(5U, ZILY_DISPLAY_TYPE_DATA, 45U, ZILY_DISPLAY_STATUS_OK, 1U);
}

/* Invalid geometry, byte count, chunk count and format are rejected without
 * disturbing the session that is already running. */
static void TestInvalidBegin(void)
{
    uint8_t payload[ZILY_DISPLAY_BEGIN_LENGTH];
    uint8_t pattern[240];
    uint16_t sequence = 50U;
    uint16_t i;
    unsigned int base;

    memset(pattern, 0x5A, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginFullScreen(sequence, 9U);
    SendChunk((uint16_t)(sequence + 1U), 9U, 0U, pattern, 240U);
    base = replyCount;
    assert(zilyDisplayNextChunk == 1U);
    assert(zilyDisplaySessionActive == 1U);

    /* x + width exceeds 128. */
    payload[0] = 9U;
    payload[1] = 100U;
    payload[2] = 0U;
    payload[3] = 64U;
    payload[4] = 8U;
    payload[5] = 0U;
    payload[6] = 64U;
    payload[7] = 0U;
    payload[8] = 1U;
    ++sequence;
    SendDisplay(ZILY_DISPLAY_TYPE_BEGIN, sequence, payload, 9U);
    CheckAck(base, ZILY_DISPLAY_TYPE_BEGIN, sequence,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* width 0. */
    payload[1] = 0U;
    payload[3] = 0U;
    ++sequence;
    SendDisplay(ZILY_DISPLAY_TYPE_BEGIN, sequence, payload, 9U);
    CheckAck(base + 1U, ZILY_DISPLAY_TYPE_BEGIN, sequence,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* format 1. */
    payload[3] = 8U;
    payload[6] = 8U;
    payload[5] = 1U;
    ++sequence;
    SendDisplay(ZILY_DISPLAY_TYPE_BEGIN, sequence, payload, 9U);
    CheckAck(base + 2U, ZILY_DISPLAY_TYPE_BEGIN, sequence,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* totalBytes does not match stride * height. */
    payload[5] = 0U;
    payload[6] = 9U;
    ++sequence;
    SendDisplay(ZILY_DISPLAY_TYPE_BEGIN, sequence, payload, 9U);
    CheckAck(base + 3U, ZILY_DISPLAY_TYPE_BEGIN, sequence,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* totalChunks does not match ceil(totalBytes / 240). */
    payload[6] = 8U;
    payload[8] = 2U;
    ++sequence;
    SendDisplay(ZILY_DISPLAY_TYPE_BEGIN, sequence, payload, 9U);
    CheckAck(base + 4U, ZILY_DISPLAY_TYPE_BEGIN, sequence,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* BEGIN with the wrong payload length. */
    ++sequence;
    SendDisplay(ZILY_DISPLAY_TYPE_BEGIN, sequence, payload, 8U);
    CheckAck(base + 5U, ZILY_DISPLAY_TYPE_BEGIN, sequence,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* None of the rejected BEGINs touched the running session. */
    assert(zilyDisplaySessionActive == 1U && zilyDisplayNextChunk == 1U);
    for (i = 1U; i < ZILY_DISPLAY_MAX_CHUNKS; ++i)
    {
        uint8_t data[240];
        uint16_t count = (uint16_t)(1024U - i * ZILY_DISPLAY_CHUNK_BYTES);

        if (count > ZILY_DISPLAY_CHUNK_BYTES)
        {
            count = (uint16_t)ZILY_DISPLAY_CHUNK_BYTES;
        }
        memset(data, 0x11, count);
        SendChunk((uint16_t)(sequence + i), 9U, (uint8_t)i, data, count);
    }
    EndTransfer((uint16_t)(sequence + 10U), 9U, 1U);
    assert(drawCalls == 1U && flushCalls == 1U);
}

/* Strict offset and length checks for DATA. */
static void TestDataGeometryErrors(void)
{
    uint8_t payload[ZILY_DISPLAY_DATA_HEADER_LENGTH + ZILY_DISPLAY_CHUNK_BYTES];
    uint8_t pattern[240];
    unsigned int base;

    memset(pattern, 0x22, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginFullScreen(70U, 2U);
    base = replyCount;

    /* Wrong offset for chunk 0. */
    payload[0] = 2U;
    payload[1] = 0U;
    payload[2] = 8U;
    payload[3] = 0U;
    memcpy(&payload[4], pattern, 240U);
    SendDisplay(ZILY_DISPLAY_TYPE_DATA, 71U, payload, 244U);
    CheckAck(base, ZILY_DISPLAY_TYPE_DATA, 71U,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* Short chunk 0 (239 bytes instead of 240). */
    payload[2] = 0U;
    SendDisplay(ZILY_DISPLAY_TYPE_DATA, 72U, payload, 243U);
    CheckAck(base + 1U, ZILY_DISPLAY_TYPE_DATA, 72U,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* DATA shorter than its 4-byte header. */
    SendDisplay(ZILY_DISPLAY_TYPE_DATA, 73U, payload, 3U);
    CheckAck(base + 2U, ZILY_DISPLAY_TYPE_DATA, 73U,
             ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);

    /* A well-formed retry of chunk 0 still succeeds. */
    SendDisplay(ZILY_DISPLAY_TYPE_DATA, 74U, payload, 244U);
    CheckAck(base + 3U, ZILY_DISPLAY_TYPE_DATA, 74U, ZILY_DISPLAY_STATUS_OK, 1U);
}

/* END before every chunk arrived rejects and ends the session. */
static void TestIncompleteEnd(void)
{
    uint8_t pattern[240];

    memset(pattern, 0x77, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginFullScreen(80U, 8U);
    SendChunk(81U, 8U, 0U, pattern, 240U);
    EndTransfer(82U, 8U, 1U);
    CheckAck(2U, ZILY_DISPLAY_TYPE_END, 82U, ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 0U);
    assert(drawCalls == 0U && flushCalls == 0U);
    assert(zilyDisplaySessionActive == 0U);

    /* The session is gone: more data now reports BAD_SESSION. */
    SendChunk(83U, 8U, 1U, pattern, 240U);
    CheckAck(3U, ZILY_DISPLAY_TYPE_DATA, 83U, ZILY_DISPLAY_STATUS_BAD_SESSION, 0U);
}

/* END failure mapping: draw -> INTERNAL, flush -> IO_ERROR; both keep the
 * session so the host can resend END. flags must be exactly 0x01 in V1. */
static void TestEndFailureRecovery(void)
{
    uint8_t pattern[240];
    uint16_t i;
    uint32_t i2cErrors;

    memset(pattern, 0x3C, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginFullScreen(90U, 1U);
    for (i = 0U; i < ZILY_DISPLAY_MAX_CHUNKS; ++i)
    {
        uint16_t count = (uint16_t)(1024U - i * ZILY_DISPLAY_CHUNK_BYTES);

        if (count > ZILY_DISPLAY_CHUNK_BYTES)
        {
            count = (uint16_t)ZILY_DISPLAY_CHUNK_BYTES;
        }
        SendChunk((uint16_t)(91U + i), 1U, (uint8_t)i, pattern, count);
    }

    /* flags != 0x01: rejected, no transfer, session kept. */
    EndTransfer(100U, 1U, 0U);
    CheckAck((unsigned int)(1U + ZILY_DISPLAY_MAX_CHUNKS), ZILY_DISPLAY_TYPE_END,
             100U, ZILY_DISPLAY_STATUS_BAD_PAYLOAD, ZILY_DISPLAY_MAX_CHUNKS);
    assert(drawCalls == 0U);
    assert(zilyDisplaySessionActive == 1U);

    /* Draw failure maps to INTERNAL and keeps the session. */
    drawResult = 0U;
    EndTransfer(101U, 1U, 1U);
    CheckAck((unsigned int)(2U + ZILY_DISPLAY_MAX_CHUNKS), ZILY_DISPLAY_TYPE_END,
             101U, ZILY_DISPLAY_STATUS_INTERNAL, ZILY_DISPLAY_MAX_CHUNKS);
    assert(flushCalls == 0U);
    assert(zilyDisplaySessionActive == 1U);

    /* Flush failure maps to IO_ERROR and keeps the session. */
    drawResult = 1U;
    flushResult = ZILY_I2C_TIMEOUT;
    i2cErrors = zilyDisplayI2cErrorCount;
    EndTransfer(102U, 1U, 1U);
    CheckAck((unsigned int)(3U + ZILY_DISPLAY_MAX_CHUNKS), ZILY_DISPLAY_TYPE_END,
             102U, ZILY_DISPLAY_STATUS_IO_ERROR, ZILY_DISPLAY_MAX_CHUNKS);
    assert(zilyDisplayI2cErrorCount == i2cErrors + 1U);
    assert(zilyDisplaySessionActive == 1U);

    /* A resent END after the fault clears succeeds. */
    flushResult = ZILY_I2C_OK;
    EndTransfer(103U, 1U, 1U);
    CheckAck((unsigned int)(4U + ZILY_DISPLAY_MAX_CHUNKS), ZILY_DISPLAY_TYPE_END,
             103U, ZILY_DISPLAY_STATUS_OK, 0U);
    assert(zilyDisplaySessionActive == 0U);
}

/* A new BEGIN replaces the running session, including its staged buffer. */
static void TestBeginOverridesSession(void)
{
    uint8_t pattern[240];

    memset(pattern, 0x01, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginRegion(110U, 1U, 0U, 0U, 128U, 64U);
    SendChunk(111U, 1U, 0U, pattern, 240U);
    assert(zilyDisplayNextChunk == 1U);

    BeginRegion(112U, 2U, 0U, 56U, 16U, 8U);
    CheckAck(2U, ZILY_DISPLAY_TYPE_BEGIN, 112U, ZILY_DISPLAY_STATUS_OK, 0U);
    assert(zilyDisplayNextChunk == 0U);

    /* Old session id is rejected while the new one is active. */
    SendChunk(113U, 1U, 1U, pattern, 240U);
    CheckAck(3U, ZILY_DISPLAY_TYPE_DATA, 113U, ZILY_DISPLAY_STATUS_BAD_SESSION, 0U);

    /* The 16x8 region needs exactly two bytes per row. */
    {
        const uint8_t bitmap[16] =
            {0xFF, 0x81, 0x81, 0x81, 0xFF, 0x81, 0x81, 0xFF,
             0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF};
        uint8_t payload[ZILY_DISPLAY_DATA_HEADER_LENGTH + 16];

        payload[0] = 2U;
        payload[1] = 0U;
        payload[2] = 0U;
        payload[3] = 0U;
        memcpy(&payload[4], bitmap, sizeof(bitmap));
        SendDisplay(ZILY_DISPLAY_TYPE_DATA, 114U, payload, 20U);
        CheckAck(4U, ZILY_DISPLAY_TYPE_DATA, 114U, ZILY_DISPLAY_STATUS_OK, 1U);
        EndTransfer(115U, 2U, 1U);
        CheckAck(5U, ZILY_DISPLAY_TYPE_END, 115U, ZILY_DISPLAY_STATUS_OK, 0U);
        assert(drawCalls == 1U && flushCalls == 1U);
        assert(drawLength == 16U && memcmp(drawData, bitmap, 16U) == 0);
        assert(drawX == 0U && drawY == 56U && drawWidth == 16U && drawHeight == 8U);
    }
}

/* Extra DATA beyond the declared chunk count is refused. */
static void TestExtraChunk(void)
{
    uint8_t pattern[240];

    memset(pattern, 0x44, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginRegion(120U, 12U, 0U, 56U, 16U, 8U);
    SendChunk(121U, 12U, 0U, pattern, 16U);
    CheckAck(1U, ZILY_DISPLAY_TYPE_DATA, 121U, ZILY_DISPLAY_STATUS_OK, 1U);
    SendChunk(122U, 12U, 1U, pattern, 16U);
    CheckAck(2U, ZILY_DISPLAY_TYPE_DATA, 122U, ZILY_DISPLAY_STATUS_BAD_CHUNK, 1U);

    /* Duplicate of the only chunk is still accepted as a retransmission. */
    SendChunk(123U, 12U, 0U, pattern, 16U);
    CheckAck(3U, ZILY_DISPLAY_TYPE_DATA, 123U, ZILY_DISPLAY_STATUS_OK, 1U);

    /* END that arrives with a length other than 2 is rejected but keeps the
     * session usable. */
    {
        const uint8_t shortEnd[1] = {12U};

        SendDisplay(ZILY_DISPLAY_TYPE_END, 124U, shortEnd, 1U);
        CheckAck(4U, ZILY_DISPLAY_TYPE_END, 124U,
                 ZILY_DISPLAY_STATUS_BAD_PAYLOAD, 1U);
    }
    EndTransfer(125U, 12U, 1U);
    CheckAck(5U, ZILY_DISPLAY_TYPE_END, 125U, ZILY_DISPLAY_STATUS_OK, 0U);
    assert(drawCalls == 1U);

    /* A second END has no session to end. */
    EndTransfer(126U, 12U, 1U);
    CheckAck(6U, ZILY_DISPLAY_TYPE_END, 126U, ZILY_DISPLAY_STATUS_BAD_SESSION, 0U);
}

/* Reserved display types answer UNSUPPORTED; 0x43 and non-display types stay
 * silent and are handled by the existing unknown-TYPE path. */
static void TestReservedTypes(void)
{
    const uint32_t unsupportedBefore = zilyUartUnsupportedTypeCount;

    ResetReplies();
    SendDisplay(0x44U, 130U, NULL, 0U);
    CheckAck(0U, 0x44U, 130U, ZILY_DISPLAY_STATUS_UNSUPPORTED, 0U);
    SendDisplay(0x4FU, 131U, NULL, 0U);
    CheckAck(1U, 0x4FU, 131U, ZILY_DISPLAY_STATUS_UNSUPPORTED, 0U);
    assert(replyCount == 2U);

    ResetReplies();
    SendDisplay(0x43U, 132U, NULL, 0U);
    SendDisplay(0x50U, 133U, NULL, 0U);
    assert(replyCount == 0U);
    assert(zilyUartUnsupportedTypeCount == unsupportedBefore + 2U);
}

/* Display frames interleaved with PING and application commands must not
 * disturb either side. */
static void TestInterleavedCommands(void)
{
    static const uint8_t ping[] = {0xA5, 0x5A, 1, 1, 1, 0, 0, 0, 0x55, 0x97};
    static const uint8_t pong[] = {0xA5, 0x5A, 1, 2, 1, 0, 0, 0, 0x87, 0x79};
    static const uint8_t appPause[] = {0xA5, 0x5A, 1, 0x10, 5, 0, 0, 0, 0xAF, 0xF3};
    static const uint8_t appPauseAck[] =
        {0xA5, 0x5A, 1, 0x90, 5, 0, 3, 0, 0x10, 0, 0, 0x72, 0xE7};
    uint8_t pattern[240];

    memset(pattern, 0x66, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginFullScreen(140U, 6U);
    Feed(ping, sizeof(ping));
    CheckReply(1U, pong, sizeof(pong));
    Feed(appPause, sizeof(appPause));
    CheckReply(2U, appPauseAck, sizeof(appPauseAck));
    SendChunk(141U, 6U, 0U, pattern, 240U);
    CheckAck(3U, ZILY_DISPLAY_TYPE_DATA, 141U, ZILY_DISPLAY_STATUS_OK, 1U);
    assert(zilyDisplaySessionActive == 1U);
}

/* A failing send callback must not change the session state. */
static void TestAckSendFailure(void)
{
    uint8_t pattern[240];

    memset(pattern, 0x12, sizeof(pattern));
    ResetReplies();
    ResetOled();
    BeginFullScreen(150U, 15U);
    sendResult = 0U;
    SendChunk(151U, 15U, 0U, pattern, 240U);
    sendResult = 1U;
    assert(replyCount == 2U);
    assert(zilyDisplayNextChunk == 1U);
    assert(zilyDisplaySessionActive == 1U);
}

int main(void)
{
    TestDocumentGoldenVectors();
    TestFullScreenUpdate();
    TestDuplicateAndOutOfOrderChunks();
    TestSessionErrors();
    TestInvalidBegin();
    TestDataGeometryErrors();
    TestIncompleteEnd();
    TestEndFailureRecovery();
    TestBeginOverridesSession();
    TestExtraChunk();
    TestReservedTypes();
    TestInterleavedCommands();
    TestAckSendFailure();
    puts("Display service tests passed");
    return 0;
}