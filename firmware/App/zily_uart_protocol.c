#include "zily_uart_protocol.h"

#include <string.h>

#include "zily_app_state.h"
#include "zily_display_service.h"

#define ZILY_UART_SOF_FIRST       0xA5U
#define ZILY_UART_SOF_SECOND      0x5AU
#define ZILY_UART_VERSION         0x01U
#define ZILY_UART_PING            0x01U
#define ZILY_UART_PONG            0x02U
#define ZILY_UART_ECHO            0x03U
#define ZILY_UART_ECHO_REPLY      0x04U

/* Application command range and its generic acknowledgement. */
#define ZILY_UART_APP_FIRST       0x10U
#define ZILY_UART_APP_LAST        0x3FU
#define ZILY_UART_APP_ACK         0x90U
#define ZILY_UART_APP_ACK_LENGTH  3U

#define ZILY_UART_VERSION_OFFSET  2U
#define ZILY_UART_TYPE_OFFSET     3U
#define ZILY_UART_SEQUENCE_OFFSET 4U
#define ZILY_UART_LENGTH_OFFSET   6U
#define ZILY_UART_HEADER_SIZE     8U
#define ZILY_UART_FRAME_OVERHEAD  (ZILY_UART_HEADER_SIZE + 2U)
#define ZILY_UART_MAX_PAYLOAD     256U
#define ZILY_UART_MAX_FRAME       (ZILY_UART_FRAME_OVERHEAD + ZILY_UART_MAX_PAYLOAD)

static uint8_t rxFrame[ZILY_UART_MAX_FRAME];
static uint8_t txFrame[ZILY_UART_MAX_FRAME];
static uint16_t rxSize;
/* FSM milestones: first SOF byte, full SOF, version, header, or full frame. */
static uint16_t rxNextCheck = 1U;

volatile uint32_t zilyUartValidFrameCount;
volatile uint32_t zilyUartCrcErrorCount;
volatile uint32_t zilyUartFrameFormatErrorCount;
volatile uint32_t zilyUartFrameLengthErrorCount;
volatile uint32_t zilyUartUnsupportedTypeCount;
volatile uint32_t zilyUartPingCount;
volatile uint32_t zilyUartEchoCount;
volatile uint32_t zilyUartAppCommandCount;
volatile uint32_t zilyUartAppNackCount;
volatile uint32_t zilyUartTxFrameCount;
volatile uint32_t zilyUartTxErrorCount;
volatile uint32_t zilyUartProtocolResetCount;
volatile uint32_t zilyUartFrameTimeoutCount;
volatile uint32_t zilyUartEventFrameCount;
volatile uint32_t zilyUartEventTypeErrorCount;

uint16_t ZilyUartProtocolCrc16(const uint8_t *data, uint16_t length)
{
    /* Four MSB-first shifts with polynomial 0x1021 per table lookup. */
    static const uint16_t table[16] = {
        0x0000U, 0x1021U, 0x2042U, 0x3063U,
        0x4084U, 0x50A5U, 0x60C6U, 0x70E7U,
        0x8108U, 0x9129U, 0xA14AU, 0xB16BU,
        0xC18CU, 0xD1ADU, 0xE1CEU, 0xF1EFU
    };
    uint16_t crc = 0xFFFFU;
    uint16_t index;

    for (index = 0U; index < length; ++index)
    {
        const uint8_t byte = data[index];
        crc = (uint16_t)((crc << 4U) ^ table[(crc >> 12U) ^ (byte >> 4U)]);
        crc = (uint16_t)((crc << 4U) ^ table[(crc >> 12U) ^ (byte & 0x0FU)]);
    }

    return crc;
}

static uint16_t ReadLe16(const uint8_t *data)
{
    return (uint16_t)((uint16_t)data[0] | ((uint16_t)data[1] << 8U));
}

static void WriteLe16(uint8_t *data, uint16_t value)
{
    data[0] = (uint8_t)value;
    data[1] = (uint8_t)(value >> 8U);
}

static uint8_t SendReply(uint8_t type, uint16_t sequence, const uint8_t *payload,
                         uint16_t length, ZilyUartSendFrame send)
{
    const uint16_t crcOffset = (uint16_t)(ZILY_UART_HEADER_SIZE + length);
    uint16_t crc;

    txFrame[0] = ZILY_UART_SOF_FIRST;
    txFrame[1] = ZILY_UART_SOF_SECOND;
    txFrame[ZILY_UART_VERSION_OFFSET] = ZILY_UART_VERSION;
    txFrame[ZILY_UART_TYPE_OFFSET] = type;
    WriteLe16(&txFrame[ZILY_UART_SEQUENCE_OFFSET], sequence);
    WriteLe16(&txFrame[ZILY_UART_LENGTH_OFFSET], length);
    if (length != 0U)
    {
        memcpy(&txFrame[ZILY_UART_HEADER_SIZE], payload, length);
    }
    crc = ZilyUartProtocolCrc16(&txFrame[ZILY_UART_VERSION_OFFSET],
                              (uint16_t)(crcOffset - ZILY_UART_VERSION_OFFSET));
    WriteLe16(&txFrame[crcOffset], crc);

    if (send(txFrame, (uint16_t)(crcOffset + 2U)) != 0U)
    {
        ++zilyUartTxFrameCount;
        return 1U;
    }

    ++zilyUartTxErrorCount;
    return 0U;
}

static void SendAppAck(uint8_t command, uint16_t sequence, uint8_t status,
                       ZilyUartSendFrame send)
{
    uint8_t payload[ZILY_UART_APP_ACK_LENGTH];

    payload[0] = command;
    payload[1] = status;
    payload[2] = ZilyAppStateFlags();
    SendReply(ZILY_UART_APP_ACK, sequence, payload, ZILY_UART_APP_ACK_LENGTH, send);
}

void ZilyUartProtocolSendReply(uint8_t type, uint16_t sequence,
                               const uint8_t *payload, uint16_t length,
                               ZilyUartSendFrame send)
{
    if ((payload == NULL) || (send == NULL) ||
        (length > ZILY_UART_MAX_PAYLOAD))
    {
        return;
    }
    (void)SendReply(type, sequence, payload, length, send);
}

uint8_t ZilyUartProtocolSendEvent(uint8_t type, const uint8_t *payload,
                                  uint16_t length, ZilyUartSendFrame send)
{
    /* Only the 0xC0-0xEF device-event range may leave through this path; a
     * command/reply range event would look like a host command on the wire. */
    if ((type < ZILY_UART_EVENT_FIRST) || (type > ZILY_UART_EVENT_LAST) ||
        (send == NULL) || ((payload == NULL) && (length != 0U)) ||
        (length > ZILY_UART_MAX_PAYLOAD))
    {
        ++zilyUartEventTypeErrorCount;
        return 0U;
    }

    /* Unsolicited events use SEQ=0 and expect no ACK. */
    if (SendReply(type, 0U, payload, length, send) != 0U)
    {
        ++zilyUartEventFrameCount;
        return 1U;
    }

    return 0U;
}

static void DispatchFrame(const uint8_t *frame, uint16_t length, ZilyUartSendFrame send)
{
    const uint8_t type = frame[ZILY_UART_TYPE_OFFSET];
    const uint16_t sequence = ReadLe16(&frame[ZILY_UART_SEQUENCE_OFFSET]);
    const uint8_t *payload = &frame[ZILY_UART_HEADER_SIZE];
    uint8_t status;

    if (((type == ZILY_UART_PING) || (type == ZILY_UART_PONG)) && (length != 0U))
    {
        ++zilyUartFrameFormatErrorCount;
        return;
    }

    ++zilyUartValidFrameCount;

    /* Application commands always receive exactly one APP_ACK, including
     * unsupported types and invalid payloads. The ACK is built and sent in
     * this task context because SendReply reuses the static txFrame. */
    if ((type >= ZILY_UART_APP_FIRST) && (type <= ZILY_UART_APP_LAST))
    {
        status = ZilyAppStateExecute(type, payload, length);
        ++zilyUartAppCommandCount;
        if (status != ZILY_APP_STATUS_OK)
        {
            ++zilyUartAppNackCount;
            if (status == ZILY_APP_STATUS_UNSUPPORTED)
            {
                ++zilyUartUnsupportedTypeCount;
            }
        }
        SendAppAck(type, sequence, status, send);
        return;
    }

    /* 0-8A display transfers are their own command class. A handled display
     * TYPE always answers with DISPLAY_ACK and never counts as an unsupported
     * application type; unhandled types fall through unchanged. */
    if (ZilyDisplayHandleCommand(type, sequence, payload, length, send) != 0U)
    {
        return;
    }

    switch (type)
    {
        case ZILY_UART_PING:
            ++zilyUartPingCount;
            SendReply(ZILY_UART_PONG, sequence, payload, length, send);
            break;
        case ZILY_UART_ECHO:
            ++zilyUartEchoCount;
            SendReply(ZILY_UART_ECHO_REPLY, sequence, payload, length, send);
            break;
        case ZILY_UART_PONG:
        case ZILY_UART_ECHO_REPLY:
            break;
        default:
            ++zilyUartUnsupportedTypeCount;
            break;
    }
}

/* Return bytes consumed. A rejected candidate advances one byte, so a later
 * SOF can start inside its header, payload, or CRC. Zero waits for rxNextCheck. */
static uint16_t ParseCandidate(const uint8_t *frame, uint16_t available,
                               ZilyUartSendFrame send)
{
    uint16_t length;
    uint16_t crcOffset;

    if (frame[0] != ZILY_UART_SOF_FIRST)
    {
        return 1U;
    }
    rxNextCheck = 2U;
    if (available < rxNextCheck)
    {
        return 0U;
    }
    if (frame[1] != ZILY_UART_SOF_SECOND)
    {
        return 1U;
    }
    rxNextCheck = ZILY_UART_VERSION_OFFSET + 1U;
    if (available < rxNextCheck)
    {
        return 0U;
    }
    if (frame[ZILY_UART_VERSION_OFFSET] != ZILY_UART_VERSION)
    {
        ++zilyUartFrameFormatErrorCount;
        return 1U;
    }
    rxNextCheck = ZILY_UART_HEADER_SIZE;
    if (available < rxNextCheck)
    {
        return 0U;
    }

    length = ReadLe16(&frame[ZILY_UART_LENGTH_OFFSET]);
    if (length > ZILY_UART_MAX_PAYLOAD)
    {
        ++zilyUartFrameLengthErrorCount;
        return 1U;
    }
    rxNextCheck = (uint16_t)(ZILY_UART_FRAME_OVERHEAD + length);
    if (available < rxNextCheck)
    {
        return 0U;
    }

    crcOffset = (uint16_t)(ZILY_UART_HEADER_SIZE + length);
    if (ZilyUartProtocolCrc16(&frame[ZILY_UART_VERSION_OFFSET],
                             (uint16_t)(crcOffset - ZILY_UART_VERSION_OFFSET)) !=
        ReadLe16(&frame[crcOffset]))
    {
        ++zilyUartCrcErrorCount;
        return 1U;
    }

    DispatchFrame(frame, length, send);
    return (uint16_t)(crcOffset + 2U);
}

static void ScanBufferedFrames(uint16_t start, uint8_t expired, ZilyUartSendFrame send)
{
    while (start < rxSize)
    {
        const uint16_t consumed = ParseCandidate(&rxFrame[start], (uint16_t)(rxSize - start), send);
        if ((consumed == 0U) && (expired == 0U))
        {
            break;
        }
        start = (uint16_t)(start + ((consumed == 0U) ? 1U : consumed));
    }

    rxSize = (uint16_t)(rxSize - start);
    if (rxSize == 0U)
    {
        rxNextCheck = 1U;
    }
    else if (start != 0U)
    {
        memmove(rxFrame, &rxFrame[start], rxSize);
    }
}

void ZilyUartProtocolReceiveByte(uint8_t data, ZilyUartSendFrame send)
{
    /* Every scan leaves rxSize below its next milestone, at most 266 bytes. */
    rxFrame[rxSize++] = data;
    if (rxSize == rxNextCheck)
    {
        ScanBufferedFrames(0U, 0U, send);
    }
}

uint8_t ZilyUartProtocolHasPendingFrame(void)
{
    return rxSize != 0U;
}

void ZilyUartProtocolExpire(ZilyUartSendFrame send)
{
    if (rxSize != 0U)
    {
        ++zilyUartFrameTimeoutCount;
        ScanBufferedFrames(1U, 1U, send);
    }
}

void ZilyUartProtocolReset(void)
{
    rxSize = 0U;
    rxNextCheck = 1U;
    ++zilyUartProtocolResetCount;
}
