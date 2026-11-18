#include "zily_uart_protocol.h"

#include "zily_app_state.h"
#include "zily_oled.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

/* The 0-8A display service links into this binary so TYPE dispatch is covered.
 * These stubs keep the I2C/OLED hardware path out of the host build; the
 * display state machine itself is tested in display_service_test.c. */
uint8_t ZILY_OLED_DrawBitmap(uint16_t x, uint16_t y, uint16_t width,
                            uint16_t height, const uint8_t *data, size_t length)
{
    (void)x;
    (void)y;
    (void)width;
    (void)height;
    (void)data;
    (void)length;
    return 1U;
}

ZilyI2cStatus ZILY_OLED_FlushRegion(uint16_t x, uint16_t y,
                                   uint16_t width, uint16_t height)
{
    (void)x;
    (void)y;
    (void)width;
    (void)height;
    return ZILY_I2C_OK;
}

static const uint8_t ping[] = {0xA5, 0x5A, 1, 1, 1, 0, 0, 0, 0x55, 0x97};
static const uint8_t pong[] = {0xA5, 0x5A, 1, 2, 1, 0, 0, 0, 0x87, 0x79};
static const uint8_t echoAbc[] = {0xA5, 0x5A, 1, 3, 2, 0, 3, 0, 'A', 'B', 'C', 0x81, 0x8C};
static const uint8_t replyAbc[] = {0xA5, 0x5A, 1, 4, 2, 0, 3, 0, 'A', 'B', 'C', 0x99, 0x4B};

/* 0-7A application command golden vectors. State starts at playing=0,
 * favorited=0; the sequence exercises PAUSE, RESUME, NEXT and FAVORITE. */
static const uint8_t appPause[] = {0xA5, 0x5A, 1, 0x10, 5, 0, 0, 0, 0xAF, 0xF3};
static const uint8_t appPauseAck[] = {0xA5, 0x5A, 1, 0x90, 5, 0, 3, 0, 0x10, 0, 0, 0x72, 0xE7};
static const uint8_t appResume[] = {0xA5, 0x5A, 1, 0x11, 6, 0, 0, 0, 0x22, 0xC2};
static const uint8_t appResumeAck[] = {0xA5, 0x5A, 1, 0x90, 6, 0, 3, 0, 0x11, 0, 1, 0xE1, 0x18};
static const uint8_t appNext[] = {0xA5, 0x5A, 1, 0x12, 7, 0, 0, 0, 0x44, 0x5A};
static const uint8_t appNextAck[] = {0xA5, 0x5A, 1, 0x90, 7, 0, 3, 0, 0x12, 0, 1, 0xD0, 0xF9};
static const uint8_t appFavoriteOn[] = {0xA5, 0x5A, 1, 0x13, 8, 0, 1, 0, 1, 0xF7, 0xB8};
static const uint8_t appFavoriteOnAck[] = {0xA5, 0x5A, 1, 0x90, 8, 0, 3, 0, 0x13, 0, 3, 0x4B, 0x64};
static const uint8_t appFavoriteOff[] = {0xA5, 0x5A, 1, 0x13, 9, 0, 1, 0, 0, 0x87, 0x02};
static const uint8_t appFavoriteOffAck[] = {0xA5, 0x5A, 1, 0x90, 9, 0, 3, 0, 0x13, 0, 1, 0x68, 0xFC};
static const uint8_t appPauseWithPayload[] = {0xA5, 0x5A, 1, 0x10, 0x0A, 0, 1, 0, 0, 0xB5, 0x22};
static const uint8_t appPauseNack[] = {0xA5, 0x5A, 1, 0x90, 0x0A, 0, 3, 0, 0x10, 2, 1, 0xD8, 0x1B};
static const uint8_t appFavoriteInvalid[] = {0xA5, 0x5A, 1, 0x13, 0x0B, 0, 1, 0, 2, 0x46, 0x66};
static const uint8_t appFavoriteInvalidAck[] = {0xA5, 0x5A, 1, 0x90, 0x0B, 0, 3, 0, 0x13, 2, 1, 0xE9, 0xFA};
static const uint8_t appQuery[] = {0xA5, 0x5A, 1, 0x14, 0x0C, 0, 0, 0, 0xDE, 0x89};
static const uint8_t appQueryNack[] = {0xA5, 0x5A, 1, 0x90, 0x0C, 0, 3, 0, 0x14, 1, 1, 0x6E, 0x33};
static const uint8_t appPauseSplit[] = {0xA5, 0x5A, 1, 0x10, 0x0D, 0, 0, 0, 0x6C, 0x76};
static const uint8_t appPauseSplitAck[] = {0xA5, 0x5A, 1, 0x90, 0x0D, 0, 3, 0, 0x10, 0, 0, 0xDF, 0x74};
static const uint8_t appPauseJoined[] = {0xA5, 0x5A, 1, 0x10, 0x0E, 0, 0, 0, 0xB0, 0xED};
static const uint8_t appPauseJoinedAck[] = {0xA5, 0x5A, 1, 0x90, 0x0E, 0, 3, 0, 0x10, 0, 0, 0x5D, 0xAC};
static const uint8_t appResumeJoined[] = {0xA5, 0x5A, 1, 0x11, 0x0F, 0, 0, 0, 0x55, 0x31};
static const uint8_t appResumeJoinedAck[] = {0xA5, 0x5A, 1, 0x90, 0x0F, 0, 3, 0, 0x11, 0, 1, 0x2D, 0x33};

static uint8_t replies[8][266];
static uint16_t replyLengths[8];
static unsigned int replyCount;
static uint8_t sendResult = 1U;

static uint8_t CaptureReply(const uint8_t *data, uint16_t length)
{
    assert(replyCount < 8U);
    assert(length <= sizeof(replies[0]));
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

static void CheckReply(unsigned int index, const uint8_t *expected, size_t length)
{
    assert(index < replyCount);
    assert(replyLengths[index] == length);
    assert(memcmp(replies[index], expected, length) == 0);
}

/* Independent bitwise reference for checking the nibble-table implementation. */
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

/* Build one frame with the independent reference CRC. */
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

static void TestValidFrames(void)
{
    uint8_t maxFrame[266] = {0xA5, 0x5A, 1, 3, 0x34, 0x12, 0, 1};
    uint8_t emptyEcho[10] = {0xA5, 0x5A, 1, 3, 0xFE, 0xFF, 0, 0};
    uint8_t stream[sizeof(ping) + sizeof(echoAbc)];
    unsigned int i;

    assert(ZilyUartProtocolCrc16((const uint8_t *)"123456789", 9) == 0x29B1U);
    assert(ZilyUartProtocolCrc16(&ping[2], sizeof(ping) - 4U) == 0x9755U);
    assert(ZilyUartProtocolCrc16(&pong[2], sizeof(pong) - 4U) == 0x7987U);
    assert(ZilyUartProtocolCrc16(&echoAbc[2], sizeof(echoAbc) - 4U) == 0x8C81U);
    assert(ZilyUartProtocolCrc16(&replyAbc[2], sizeof(replyAbc) - 4U) == 0x4B99U);

    memcpy(stream, ping, sizeof(ping));
    memcpy(&stream[sizeof(ping)], echoAbc, sizeof(echoAbc));
    Feed(ping, 1);
    assert(replyCount == 0 && ZilyUartProtocolHasPendingFrame());
    Feed(stream, 4); /* Overlapping A5 A5 5A, split header. */
    assert(replyCount == 0 && ZilyUartProtocolHasPendingFrame());
    Feed(&stream[4], sizeof(stream) - 4U);
    assert(replyCount == 2 && !ZilyUartProtocolHasPendingFrame());
    CheckReply(0, pong, sizeof(pong));
    CheckReply(1, replyAbc, sizeof(replyAbc));

    for (i = 0; i < 256U; ++i)
    {
        maxFrame[8U + i] = (uint8_t)i;
    }
    /* Even an entire valid PING inside a valid ECHO belongs to the payload. */
    memcpy(&maxFrame[25], ping, sizeof(ping));
    WriteReferenceCrc(maxFrame, sizeof(maxFrame));
    WriteReferenceCrc(emptyEcho, sizeof(emptyEcho));
    replyCount = 0;
    Feed(maxFrame, sizeof(maxFrame));
    Feed(emptyEcho, sizeof(emptyEcho));
    maxFrame[3] = 4;
    emptyEcho[3] = 4;
    WriteReferenceCrc(maxFrame, sizeof(maxFrame));
    WriteReferenceCrc(emptyEcho, sizeof(emptyEcho));
    CheckReply(0, maxFrame, sizeof(maxFrame));
    CheckReply(1, emptyEcho, sizeof(emptyEcho));
    assert(zilyUartValidFrameCount == 4 && zilyUartPingCount == 1 && zilyUartEchoCount == 3);
    assert(zilyUartTxFrameCount == 4 && zilyUartCrcErrorCount == 0);
}

static void TestRecovery(void)
{
    uint8_t badCrc[sizeof(ping)];
    const uint8_t longHeader[] = {0xA5, 0x5A, 1, 3, 0, 0, 0, 1};
    const uint8_t illegalLength[] = {0xA5, 0x5A, 1, 3, 0, 0, 1, 1};
    const uint8_t illegalVersion[] = {0xA5, 0x5A, 2};
    const uint8_t swallowingHeader[] = {0xA5, 0x5A, 1, 3, 0, 0, 8, 0};

    replyCount = 0;
    memcpy(badCrc, ping, sizeof(ping));
    badCrc[9] ^= 1;
    Feed(badCrc, sizeof(badCrc));
    assert(replyCount == 0 && zilyUartCrcErrorCount == 1);
    Feed(ping, sizeof(ping));
    CheckReply(0, pong, sizeof(pong));
    Feed(swallowingHeader, sizeof(swallowingHeader));
    Feed(ping, sizeof(ping)); /* The false frame's length covers the PING. */
    assert(replyCount == 2 && zilyUartCrcErrorCount == 2);
    CheckReply(1, pong, sizeof(pong));

    replyCount = 0;
    Feed(illegalVersion, sizeof(illegalVersion));
    Feed(illegalLength, sizeof(illegalLength));
    assert(replyCount == 0 && !ZilyUartProtocolHasPendingFrame());
    Feed(ping, sizeof(ping));
    CheckReply(0, pong, sizeof(pong));
    assert(zilyUartFrameFormatErrorCount == 1 && zilyUartFrameLengthErrorCount == 1);

    replyCount = 0;
    Feed(longHeader, sizeof(longHeader));
    Feed(ping, sizeof(ping));
    assert(replyCount == 0 && ZilyUartProtocolHasPendingFrame());
    ZilyUartProtocolExpire(CaptureReply);
    assert(replyCount == 1 && zilyUartFrameTimeoutCount == 1);
    CheckReply(0, pong, sizeof(pong));
    assert(!ZilyUartProtocolHasPendingFrame());

    replyCount = 0;
    Feed(ping, 6);
    ZilyUartProtocolReset(); /* Task has seen a receive discontinuity. */
    Feed(&ping[6], sizeof(ping) - 6U);
    assert(replyCount == 0 && zilyUartProtocolResetCount == 1);
    Feed(ping, sizeof(ping));
    CheckReply(0, pong, sizeof(pong));
}

static void TestCommandAndSendErrors(void)
{
    uint8_t unknown[sizeof(ping)];
    uint8_t pingWithPayload[sizeof(echoAbc)];
    const uint32_t successfulTx = zilyUartTxFrameCount;
    const uint32_t validFrames = zilyUartValidFrameCount;

    replyCount = 0;
    Feed(pong, sizeof(pong));
    Feed(replyAbc, sizeof(replyAbc));
    memcpy(unknown, ping, sizeof(ping));
    unknown[3] = 0xF0;
    WriteReferenceCrc(unknown, sizeof(unknown));
    Feed(unknown, sizeof(unknown));
    memcpy(pingWithPayload, echoAbc, sizeof(echoAbc));
    pingWithPayload[3] = 1;
    WriteReferenceCrc(pingWithPayload, sizeof(pingWithPayload));
    Feed(pingWithPayload, sizeof(pingWithPayload));
    assert(replyCount == 0 && zilyUartUnsupportedTypeCount == 1);
    assert(zilyUartFrameFormatErrorCount == 2 && zilyUartValidFrameCount == validFrames + 3U);

    sendResult = 0;
    Feed(ping, sizeof(ping));
    assert(replyCount == 1 && zilyUartTxErrorCount == 1 && zilyUartTxFrameCount == successfulTx);
}

static void TestAppCommands(void)
{
    const uint32_t validFrames = zilyUartValidFrameCount;
    const uint32_t appCommands = zilyUartAppCommandCount;
    const uint32_t appNacks = zilyUartAppNackCount;
    const uint32_t unsupported = zilyUartUnsupportedTypeCount;
    const uint32_t txFrames = zilyUartTxFrameCount;
    /* 0x43 is the reserved display slot and stays silent, like 0x05/0x90. */
    const uint8_t silentTypes[4] = {0x05U, 0x43U, 0x90U, 0xF0U};
    uint8_t silent[10];
    uint8_t nested[266];
    uint8_t nestedReply[266];
    uint8_t joined[sizeof(appPauseJoined) + sizeof(appResumeJoined)];
    uint16_t nestedLength;
    uint16_t nestedReplyLength;
    size_t split;
    uint32_t appCountBefore;
    uint32_t txErrorsBefore;
    uint32_t txFramesBefore;
    unsigned int i;

    sendResult = 1U;
    replyCount = 0;

    /* Golden command/ACK vectors. */
    Feed(appPause, sizeof(appPause));
    CheckReply(0, appPauseAck, sizeof(appPauseAck));
    Feed(appResume, sizeof(appResume));
    CheckReply(1, appResumeAck, sizeof(appResumeAck));
    Feed(appNext, sizeof(appNext));
    CheckReply(2, appNextAck, sizeof(appNextAck));
    Feed(appFavoriteOn, sizeof(appFavoriteOn));
    CheckReply(3, appFavoriteOnAck, sizeof(appFavoriteOnAck));
    Feed(appFavoriteOff, sizeof(appFavoriteOff));
    CheckReply(4, appFavoriteOffAck, sizeof(appFavoriteOffAck));
    assert(replyCount == 5U && !ZilyUartProtocolHasPendingFrame());
    assert(zilyAppPlaying == 1U && zilyAppFavorited == 0U && zilyAppNextCount == 1U);

    /* Invalid payloads are NACKed and must not change state. */
    Feed(appPauseWithPayload, sizeof(appPauseWithPayload));
    CheckReply(5, appPauseNack, sizeof(appPauseNack));
    Feed(appFavoriteInvalid, sizeof(appFavoriteInvalid));
    CheckReply(6, appFavoriteInvalidAck, sizeof(appFavoriteInvalidAck));
    assert(zilyAppPlaying == 1U && zilyAppFavorited == 0U);

    /* Unimplemented command type is NACKed, not silently dropped. */
    Feed(appQuery, sizeof(appQuery));
    CheckReply(7, appQueryNack, sizeof(appQueryNack));

    /* Reserved and unknown ranges stay silent. */
    replyCount = 0;
    for (i = 0; i < 4U; ++i)
    {
        const uint16_t length = MakeFrame(silent, silentTypes[i], (uint16_t)(20U + i), NULL, 0U);
        Feed(silent, length);
    }
    assert(replyCount == 0U);

    assert(zilyUartAppCommandCount == appCommands + 8U);
    assert(zilyUartAppNackCount == appNacks + 3U);
    assert(zilyUartUnsupportedTypeCount == unsupported + 5U);
    assert(zilyUartValidFrameCount == validFrames + 12U);
    assert(zilyUartTxFrameCount == txFrames + 8U);

    /* A command split across every byte boundary still produces one ACK. */
    replyCount = 0;
    Feed(appPauseSplit, 1);
    assert(ZilyUartProtocolHasPendingFrame());
    Feed(&appPauseSplit[1], sizeof(appPauseSplit) - 1U);
    assert(replyCount == 1U && !ZilyUartProtocolHasPendingFrame());
    CheckReply(0, appPauseSplitAck, sizeof(appPauseSplitAck));

    /* Two commands in one stream produce two ACKs in order. */
    memcpy(joined, appPauseJoined, sizeof(appPauseJoined));
    memcpy(&joined[sizeof(appPauseJoined)], appResumeJoined, sizeof(appResumeJoined));
    replyCount = 0;
    Feed(joined, sizeof(joined));
    assert(replyCount == 2U);
    CheckReply(0, appPauseJoinedAck, sizeof(appPauseJoinedAck));
    CheckReply(1, appResumeJoinedAck, sizeof(appResumeJoinedAck));

    /* A full command frame inside an ECHO payload stays payload. */
    nestedLength = MakeFrame(nested, 0x03U, 30U, appPauseSplit, sizeof(appPauseSplit));
    nestedReplyLength = MakeFrame(nestedReply, 0x04U, 30U, appPauseSplit, sizeof(appPauseSplit));
    replyCount = 0;
    Feed(nested, nestedLength);
    assert(replyCount == 1U);
    CheckReply(0, nestedReply, nestedReplyLength);
    assert(zilyUartAppCommandCount == appCommands + 11U);

    /* PING still works after application traffic. */
    replyCount = 0;
    Feed(ping, sizeof(ping));
    assert(replyCount == 1U);
    CheckReply(0, pong, sizeof(pong));
    assert(!ZilyUartProtocolHasPendingFrame());

    /* Every byte boundary of a command frame still produces one ACK. */
    for (split = 1U; split < sizeof(appPauseSplit); ++split)
    {
        replyCount = 0;
        Feed(appPauseSplit, split);
        assert(ZilyUartProtocolHasPendingFrame());
        Feed(&appPauseSplit[split], sizeof(appPauseSplit) - split);
        assert(replyCount == 1U && !ZilyUartProtocolHasPendingFrame());
        CheckReply(0, appPauseSplitAck, sizeof(appPauseSplitAck));
    }

    /* A failed APP_ACK send still applies the command and counts the TX error. */
    appCountBefore = zilyUartAppCommandCount;
    txErrorsBefore = zilyUartTxErrorCount;
    txFramesBefore = zilyUartTxFrameCount;
    sendResult = 0U;
    replyCount = 0;
    Feed(appPauseSplit, sizeof(appPauseSplit));
    assert(replyCount == 1U);
    CheckReply(0, appPauseSplitAck, sizeof(appPauseSplitAck));
    assert(zilyUartTxErrorCount == txErrorsBefore + 1U);
    assert(zilyUartTxFrameCount == txFramesBefore);
    assert(zilyUartAppCommandCount == appCountBefore + 1U);
    sendResult = 1U;
}

/* 0-9A device events: ZilyUartProtocolSendEvent framing, counters, rejection
 * paths and the no-ACK guarantee. The golden frames below were cross-checked
 * against an independent CRC-16/CCITT-FALSE calculation (node one-off script,
 * "123456789" -> 0x29B1) and are rebuilt here with the reference-CRC
 * MakeFrame. This test runs last so the fixed baselines of the earlier tests
 * stay untouched; it only ever asserts counter deltas of its own. */
static const uint8_t eventKeyShort[] =
    {0xA5, 0x5A, 0x01, 0xC0, 0x00, 0x00, 0x02, 0x00, 0x01, 0x00, 0xA1, 0xDE};
static const uint8_t eventEncoderMinus1[] =
    {0xA5, 0x5A, 0x01, 0xC1, 0x00, 0x00, 0x01, 0x00, 0xFF, 0xFF, 0x9B};

static void TestSendEvent(void)
{
    const uint8_t keyPayload[2] = {1U, 0U};
    const uint8_t encoderPayload[1] = {0xFFU};
    /* APP_ACK range, just below the event range, host command range, and both
     * outer edges of the whole TYPE space. */
    const uint8_t badTypes[5] = {0x90U, 0xBFU, 0x10U, 0x00U, 0xF0U};
    uint8_t expected[16];
    uint8_t echoed[16];
    uint32_t eventFrames;
    uint32_t txFrames;
    uint32_t txErrors;
    uint32_t typeErrors;
    uint32_t validFrames;
    uint32_t unsupported;
    unsigned int i;

    sendResult = 1U;
    eventFrames = zilyUartEventFrameCount;
    txFrames = zilyUartTxFrameCount;
    txErrors = zilyUartTxErrorCount;
    typeErrors = zilyUartEventTypeErrorCount;

    /* KEY_EVENT [keyId=1, action=0]: SOF A5 5A, VER 01, TYPE C0, SEQ 00 00,
     * LEN 02 00, payload, CRC little-endian. */
    replyCount = 0;
    assert(ZilyUartProtocolSendEvent(ZILY_UART_EVENT_KEY, keyPayload, 2U,
                                     CaptureReply) == 1U);
    assert(replyCount == 1U);
    CheckReply(0, eventKeyShort, sizeof(eventKeyShort));
    assert(zilyUartEventFrameCount == eventFrames + 1U);
    assert(zilyUartTxFrameCount == txFrames + 1U);
    assert(zilyUartTxErrorCount == txErrors);
    assert(zilyUartEventTypeErrorCount == typeErrors);
    ++eventFrames;
    ++txFrames;

    /* The same frame rebuilt with the independent reference CRC. */
    assert(MakeFrame(expected, ZILY_UART_EVENT_KEY, 0U, keyPayload, 2U) ==
           sizeof(eventKeyShort));
    assert(memcmp(expected, eventKeyShort, sizeof(eventKeyShort)) == 0);

    /* ENCODER_EVENT [0xFF] == delta -1. */
    replyCount = 0;
    assert(ZilyUartProtocolSendEvent(ZILY_UART_EVENT_ENCODER, encoderPayload,
                                     1U, CaptureReply) == 1U);
    assert(replyCount == 1U);
    CheckReply(0, eventEncoderMinus1, sizeof(eventEncoderMinus1));
    assert(MakeFrame(expected, ZILY_UART_EVENT_ENCODER, 0U, encoderPayload, 1U) ==
           sizeof(eventEncoderMinus1));
    assert(memcmp(expected, eventEncoderMinus1, sizeof(eventEncoderMinus1)) == 0);
    assert(zilyUartEventFrameCount == eventFrames + 1U);
    assert(zilyUartTxFrameCount == txFrames + 1U);
    ++eventFrames;
    ++txFrames;

    /* A failing send callback: returns 0, no event count, TX error counted. */
    sendResult = 0U;
    replyCount = 0;
    assert(ZilyUartProtocolSendEvent(ZILY_UART_EVENT_KEY, keyPayload, 2U,
                                     CaptureReply) == 0U);
    assert(replyCount == 1U);            /* the frame still reached the callback */
    assert(zilyUartEventFrameCount == eventFrames);
    assert(zilyUartTxFrameCount == txFrames);
    assert(zilyUartTxErrorCount == txErrors + 1U);
    ++txErrors;
    sendResult = 1U;

    /* Illegal TYPEs are rejected: nothing on the wire, type error counted,
     * TX counters untouched. */
    for (i = 0; i < 5U; ++i)
    {
        replyCount = 0;
        assert(ZilyUartProtocolSendEvent(badTypes[i], keyPayload, 2U,
                                         CaptureReply) == 0U);
        assert(replyCount == 0U);
        assert(zilyUartTxFrameCount == txFrames);
        assert(zilyUartTxErrorCount == txErrors);
        assert(zilyUartEventFrameCount == eventFrames);
        assert(zilyUartEventTypeErrorCount == typeErrors + 1U);
        ++typeErrors;
    }

    /* payload NULL with length > 0, send NULL, and an oversized length. */
    replyCount = 0;
    assert(ZilyUartProtocolSendEvent(ZILY_UART_EVENT_KEY, NULL, 2U,
                                     CaptureReply) == 0U);
    assert(ZilyUartProtocolSendEvent(ZILY_UART_EVENT_KEY, keyPayload, 2U,
                                     NULL) == 0U);
    assert(ZilyUartProtocolSendEvent(ZILY_UART_EVENT_KEY, keyPayload, 257U,
                                     CaptureReply) == 0U);
    assert(replyCount == 0U);
    assert(zilyUartTxFrameCount == txFrames);
    assert(zilyUartEventTypeErrorCount == typeErrors + 3U);
    typeErrors += 3U;

    /* Event frames never trigger an ACK: sending emits exactly one frame, and
     * feeding that same frame back into the RX parser produces no reply (it
     * lands in the unsupported-type counter like any unknown TYPE). */
    replyCount = 0;
    assert(ZilyUartProtocolSendEvent(ZILY_UART_EVENT_KEY, keyPayload, 2U,
                                     CaptureReply) == 1U);
    assert(replyCount == 1U);            /* only the event frame itself */
    assert(replyLengths[0] == sizeof(eventKeyShort));
    assert(zilyUartEventFrameCount == eventFrames + 1U);

    memcpy(echoed, replies[0], replyLengths[0]);
    validFrames = zilyUartValidFrameCount;
    unsupported = zilyUartUnsupportedTypeCount;
    replyCount = 0;
    Feed(echoed, sizeof(eventKeyShort));
    assert(replyCount == 0U);            /* no ACK for a device event */
    assert(!ZilyUartProtocolHasPendingFrame());
    assert(zilyUartValidFrameCount == validFrames + 1U);
    assert(zilyUartUnsupportedTypeCount == unsupported + 1U);
}

int main(void)
{
    TestValidFrames();
    TestRecovery();
    TestCommandAndSendErrors();
    TestAppCommands();
    TestSendEvent();
    puts("UART protocol tests passed");
    return 0;
}