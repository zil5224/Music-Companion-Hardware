#include "zily_input_service.h"

#include <stddef.h>

static const ZilyInputHardware *inputHardware;
static const ZilyInputSink *inputSink;

/* Encoder push debounce and click state. */
static uint8_t pushRaw;
static uint8_t pushStable;
static uint8_t pushSamples;
static uint8_t singlePending;      /* a first click is waiting for the window */
static uint8_t doubleArmed;        /* a second press started inside the window */
static uint32_t singleDeadlineMs;  /* when the pending single click is emitted */

static uint32_t lastPollMs;
static uint8_t polledOnce;
static int16_t encoderRemainder;

volatile uint32_t zilyInputPollCount;
volatile uint32_t zilyInputKeyEventCount;
volatile uint32_t zilyInputDoublePressCount;
volatile uint32_t zilyInputEncoderEventCount;
volatile uint32_t zilyInputEventSendFailCount;
volatile uint8_t zilyInputLastKeyId;
volatile uint8_t zilyInputLastAction;
volatile int8_t zilyInputLastEncoderSteps;

static void EmitKeyEvent(uint8_t action)
{
    if (action == ZILY_INPUT_ACTION_DOUBLE)
    {
        ++zilyInputDoublePressCount;
    }

    if ((inputSink != NULL) && (inputSink->onKey != NULL) &&
        (inputSink->onKey(ZILY_INPUT_KEY_ENCODER, action) != 0U))
    {
        ++zilyInputKeyEventCount;
        zilyInputLastKeyId = ZILY_INPUT_KEY_ENCODER;
        zilyInputLastAction = action;
    }
    else
    {
        ++zilyInputEventSendFailCount;
    }
}

static void EmitEncoderEvent(int8_t steps)
{
    if ((inputSink != NULL) && (inputSink->onEncoder != NULL) &&
        (inputSink->onEncoder(steps) != 0U))
    {
        ++zilyInputEncoderEventCount;
        zilyInputLastEncoderSteps = steps;
    }
    else
    {
        ++zilyInputEventSendFailCount;
    }
}

static void ProcessPush(uint8_t rawPressed, uint32_t nowMs)
{
    uint8_t pressed;

    /* Symmetric debounce: a new level must hold for two consecutive samples. */
    if (rawPressed == pushRaw)
    {
        if (pushSamples < ZILY_INPUT_DEBOUNCE_SAMPLES)
        {
            ++pushSamples;
        }
    }
    else
    {
        pushRaw = rawPressed;
        pushSamples = 1U;
    }

    pressed = ((pushSamples >= ZILY_INPUT_DEBOUNCE_SAMPLES) ? pushRaw : pushStable);

    if (pressed != pushStable)
    {
        pushStable = pressed;
        if (pressed != 0U)
        {
            /* Second press inside the pending single-click window: arm a
             * double click and cancel the not-yet-sent single click. */
            if (singlePending != 0U)
            {
                singlePending = 0U;
                doubleArmed = 1U;
            }
        }
        else if (doubleArmed != 0U)
        {
            doubleArmed = 0U;
            EmitKeyEvent(ZILY_INPUT_ACTION_DOUBLE);
        }
        else
        {
            singlePending = 1U;
            singleDeadlineMs = nowMs + ZILY_INPUT_DOUBLE_PRESS_MS;
        }
    }

    if ((singlePending != 0U) &&
        ((int32_t)(nowMs - singleDeadlineMs) >= 0))
    {
        singlePending = 0U;
        EmitKeyEvent(ZILY_INPUT_ACTION_SINGLE);
    }
}

static void ProcessEncoder(void)
{
    int16_t counts;
    int16_t steps;

    counts = inputHardware->readEncoderDelta();
    counts = (int16_t)(counts * ZILY_INPUT_ENCODER_DIRECTION);
    encoderRemainder = (int16_t)(encoderRemainder + counts);

    /* Truncating division keeps the sign and the sub-detent remainder. */
    steps = (int16_t)(encoderRemainder / ZILY_INPUT_ENCODER_COUNTS_PER_DETENT);
    encoderRemainder = (int16_t)(encoderRemainder %
                                 ZILY_INPUT_ENCODER_COUNTS_PER_DETENT);

    if (steps > 127)
    {
        steps = 127;
    }
    else if (steps < -127)
    {
        steps = -127;
    }

    if (steps != 0)
    {
        EmitEncoderEvent((int8_t)steps);
    }
}

void ZilyInputServiceInit(const ZilyInputHardware *hardware,
                          const ZilyInputSink *sink)
{
    inputHardware = hardware;
    inputSink = sink;

    pushRaw = 0U;
    pushStable = 0U;
    pushSamples = 0U;
    singlePending = 0U;
    doubleArmed = 0U;
    singleDeadlineMs = 0U;

    encoderRemainder = 0;
    lastPollMs = 0U;
    polledOnce = 0U;
}

void ZilyInputServicePoll(uint32_t nowMs)
{
    uint8_t pushed;

    if ((inputHardware == NULL) || (inputSink == NULL) ||
        (inputHardware->readEncoderPush == NULL) ||
        (inputHardware->readEncoderDelta == NULL))
    {
        return;
    }

    /* Time gate: the UART task may call this more often than the poll period
     * while frames are streaming in. */
    if ((polledOnce != 0U) &&
        ((uint32_t)(nowMs - lastPollMs) < ZILY_INPUT_POLL_MS))
    {
        return;
    }

    polledOnce = 1U;
    lastPollMs = nowMs;
    ++zilyInputPollCount;

    pushed = inputHardware->readEncoderPush();
    ProcessPush(pushed, nowMs);
    ProcessEncoder();
}
