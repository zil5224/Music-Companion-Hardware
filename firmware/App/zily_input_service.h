#ifndef ZILY_INPUT_SERVICE_H
#define ZILY_INPUT_SERVICE_H

#include <stdint.h>

/* 0-9A physical input service (encoder-only): encoder push button with
 * single/double click detection, plus rotary detents.
 *
 * The service is pure logic. It never touches GPIO or the USART directly; the
 * caller injects one hardware contract (push state and raw encoder counts) and
 * one sink (how a finished event leaves the MCU). This keeps the module
 * host-testable with plain C stubs while the firmware plugs in the real
 * zily_key / zily_encoder drivers and the 0xC0/0xC1 event sender.
 *
 * Push semantics: one click = play/pause, two clicks within
 * ZILY_INPUT_DOUBLE_PRESS_MS = next song. A single click is emitted only after
 * the double-click window expires, so a double click never also pauses.
 * There is no long-press action in this phase.
 *
 * Poll cadence: ZilyInputServicePoll() is time-gated internally, so callers may
 * invoke it on every UART task iteration. Samples are taken at most once per
 * ZILY_INPUT_POLL_MS (10 ms). A level must hold for
 * ZILY_INPUT_DEBOUNCE_SAMPLES consecutive samples (20 ms) before it becomes
 * stable, on press and on release. The UART task may block for up to an OLED
 * frame transfer, so gaps between samples are allowed; presses shorter than a
 * polling gap can be missed, which is documented in the 0-9A protocol. */

#define ZILY_INPUT_KEY_ENCODER          3U

#define ZILY_INPUT_ACTION_SINGLE        0U
#define ZILY_INPUT_ACTION_LONG          1U /* reserved, not emitted in 0-9A */
#define ZILY_INPUT_ACTION_DOUBLE        2U

#define ZILY_INPUT_POLL_MS                  10U
#define ZILY_INPUT_DEBOUNCE_SAMPLES         2U
#define ZILY_INPUT_DOUBLE_PRESS_MS          280U
#define ZILY_INPUT_ENCODER_COUNTS_PER_DETENT 4

/* Set to (-1) if the real board's rotation direction is inverted. */
#define ZILY_INPUT_ENCODER_DIRECTION        (1)

typedef struct
{
    /* 1 while the encoder knob is pressed, 0 otherwise. */
    uint8_t (*readEncoderPush)(void);
    /* Signed TIM3 count delta since the previous call. */
    int16_t (*readEncoderDelta)(void);
} ZilyInputHardware;

typedef struct
{
    /* Returns 1 when the event frame was sent, 0 on a send failure. */
    uint8_t (*onKey)(uint8_t keyId, uint8_t action);
    /* steps is the signed number of detents; 1..127 or -127..-1. */
    uint8_t (*onEncoder)(int8_t steps);
} ZilyInputSink;

/* Install the hardware/sink contracts and reset the click state. Called once
 * before the UART service task starts polling. NULL means "not configured" and
 * Poll() then does nothing. */
void ZilyInputServiceInit(const ZilyInputHardware *hardware,
                          const ZilyInputSink *sink);

/* Sample hardware (time-gated) and emit finished events through the sink. */
void ZilyInputServicePoll(uint32_t nowMs);

/* Watch variables. Only the UART service task writes them in V1. */
extern volatile uint32_t zilyInputPollCount;
extern volatile uint32_t zilyInputKeyEventCount;
extern volatile uint32_t zilyInputDoublePressCount;
extern volatile uint32_t zilyInputEncoderEventCount;
extern volatile uint32_t zilyInputEventSendFailCount;
extern volatile uint8_t zilyInputLastKeyId;
extern volatile uint8_t zilyInputLastAction;
extern volatile int8_t zilyInputLastEncoderSteps;

#endif
