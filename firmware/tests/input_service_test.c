#include "zily_input_service.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

/* Host-side test for the 0-9A encoder-only input service. The real
 * zily_input_service.c runs against plain C stubs: the push level and raw
 * encoder counts are injected, finished events are captured, so the 10 ms time
 * gate, symmetric 20 ms debounce, single/double click window, 4-counts-per-
 * detent encoder and the watch counters are exercised end to end.
 *
 * Click semantics: one click = SINGLE (play/pause), two clicks within 280 ms =
 * DOUBLE (next). A single click is emitted only when the double-click window
 * expires, so a double click never also emits a single click. There is no long
 * press action in 0-9A.
 *
 * The watch counters are process-global and only ever increase (Init does not
 * clear them), so every scenario snapshots them first and asserts deltas. Each
 * scenario calls InstallStubs() which re-installs the stubs via
 * ZilyInputServiceInit() and clears the test-side capture buffers. */

#define MAX_CAPTURED 64

typedef struct
{
    uint8_t keyId;
    uint8_t action;
} CapturedKey;

static uint8_t stubPush;
static int16_t stubEncoderDelta;
static unsigned int readPushCalls;
static unsigned int readEncoderCalls;

static CapturedKey capturedKeys[MAX_CAPTURED];
static unsigned int capturedKeyCount;
static int8_t capturedEncoder[MAX_CAPTURED];
static unsigned int capturedEncoderCount;
static unsigned int sinkKeyCalls;
static unsigned int sinkEncoderCalls;
static uint8_t sinkKeyResult = 1U;
static uint8_t sinkEncoderResult = 1U;

static uint8_t StubReadEncoderPush(void)
{
    ++readPushCalls;
    return stubPush;
}

static int16_t StubReadEncoderDelta(void)
{
    ++readEncoderCalls;
    return stubEncoderDelta;
}

static uint8_t StubOnKey(uint8_t keyId, uint8_t action)
{
    ++sinkKeyCalls;
    if (capturedKeyCount < MAX_CAPTURED)
    {
        capturedKeys[capturedKeyCount].keyId = keyId;
        capturedKeys[capturedKeyCount].action = action;
        ++capturedKeyCount;
    }
    return sinkKeyResult;
}

static uint8_t StubOnEncoder(int8_t steps)
{
    ++sinkEncoderCalls;
    if (capturedEncoderCount < MAX_CAPTURED)
    {
        capturedEncoder[capturedEncoderCount] = steps;
        ++capturedEncoderCount;
    }
    return sinkEncoderResult;
}

static const ZilyInputHardware stubHardware = {StubReadEncoderPush, StubReadEncoderDelta};
static const ZilyInputSink stubSink = {StubOnKey, StubOnEncoder};

/* Partial contracts for the guard tests. */
static const ZilyInputHardware hwNullPush = {NULL, StubReadEncoderDelta};
static const ZilyInputHardware hwNullEncoder = {StubReadEncoderPush, NULL};

static uint32_t basePoll;
static uint32_t baseKeyEvent;
static uint32_t baseDouble;
static uint32_t baseEncoderEvent;
static uint32_t baseSendFail;
static uint8_t baseLastKeyId;
static uint8_t baseLastAction;
static int8_t baseLastEncoderSteps;

static void SnapshotCounters(void)
{
    basePoll = zilyInputPollCount;
    baseKeyEvent = zilyInputKeyEventCount;
    baseDouble = zilyInputDoublePressCount;
    baseEncoderEvent = zilyInputEncoderEventCount;
    baseSendFail = zilyInputEventSendFailCount;
    baseLastKeyId = zilyInputLastKeyId;
    baseLastAction = zilyInputLastAction;
    baseLastEncoderSteps = zilyInputLastEncoderSteps;
}

static void ResetCapture(void)
{
    stubPush = 0U;
    stubEncoderDelta = 0;
    readPushCalls = 0U;
    readEncoderCalls = 0U;
    capturedKeyCount = 0U;
    capturedEncoderCount = 0U;
    sinkKeyCalls = 0U;
    sinkEncoderCalls = 0U;
    sinkKeyResult = 1U;
    sinkEncoderResult = 1U;
    memset(capturedKeys, 0, sizeof(capturedKeys));
    memset(capturedEncoder, 0, sizeof(capturedEncoder));
}

static void InstallStubs(void)
{
    ResetCapture();
    ZilyInputServiceInit(&stubHardware, &stubSink);
    SnapshotCounters();
}

static void Poll(uint32_t nowMs)
{
    ZilyInputServicePoll(nowMs);
}

static void SetPush(uint8_t pressed)
{
    stubPush = pressed;
}

static void SetEncoder(int16_t counts)
{
    stubEncoderDelta = counts;
}

/* Press confirmed on the second sample (t + 10); returns that time. */
static uint32_t ConfirmPress(uint32_t t)
{
    SetPush(1U);
    SetEncoder(0);
    Poll(t);
    Poll(t + 10U);
    return t + 10U;
}

/* Full release confirmed on the second released sample (t + 20 / t + 30).
 * Returns the release time (the moment the single-click window starts). */
static uint32_t ConfirmRelease(uint32_t t)
{
    SetPush(0U);
    Poll(t + 20U);
    Poll(t + 30U);
    return t + 30U;
}

/* One click: press at t, release; the SINGLE is emitted 280 ms after the
 * release time (release + 280). Returns that emit time. */
static uint32_t OneClick(uint32_t t)
{
    uint32_t release;

    (void)ConfirmPress(t);
    release = ConfirmRelease(t);
    return release + ZILY_INPUT_DOUBLE_PRESS_MS;
}

/* ---- Scenario: first poll samples immediately; 10 ms gate blocks the rest. */
static void TestFirstPollAndTimeGate(void)
{
    InstallStubs();

    Poll(0U);
    assert(readPushCalls == 1U);
    assert(readEncoderCalls == 1U);
    assert(zilyInputPollCount == basePoll + 1U);

    Poll(0U);
    Poll(5U);
    Poll(9U);
    assert(readPushCalls == 1U && zilyInputPollCount == basePoll + 1U);

    Poll(10U);
    assert(readPushCalls == 2U && zilyInputPollCount == basePoll + 2U);

    Poll(15U);
    assert(readPushCalls == 2U);
    Poll(20U);
    assert(readPushCalls == 3U);

    assert(readEncoderCalls == readPushCalls);
    assert(capturedKeyCount == 0U && capturedEncoderCount == 0U);
}

/* ---- Scenario: the uint32 poll gate is wrap-around safe. ---- */
static void TestTimeGateWraparound(void)
{
    InstallStubs();

    Poll(0xFFFFFFF0U);
    assert(readPushCalls == 1U);
    Poll(0xFFFFFFF6U);
    assert(readPushCalls == 1U);
    Poll(0x00000002U);
    assert(readPushCalls == 2U);
}

/* ---- Scenario: one click emits exactly one SINGLE after the window. ---- */
static void TestSingleClick(void)
{
    uint32_t release;
    uint32_t emit;

    InstallStubs();
    (void)ConfirmPress(1000U);
    release = ConfirmRelease(1000U);   /* release time 1030, deadline 1310 */
    assert(capturedKeyCount == 0U);    /* waiting for the double-click window */

    Poll(release + ZILY_INPUT_DOUBLE_PRESS_MS - 10U);
    assert(capturedKeyCount == 0U);

    Poll(release + ZILY_INPUT_DOUBLE_PRESS_MS);
    emit = release + ZILY_INPUT_DOUBLE_PRESS_MS;
    assert(emit == 1310U);
    assert(capturedKeyCount == 1U);
    assert(capturedKeys[0].keyId == ZILY_INPUT_KEY_ENCODER);
    assert(capturedKeys[0].action == ZILY_INPUT_ACTION_SINGLE);
    assert(zilyInputKeyEventCount == baseKeyEvent + 1U);
    assert(zilyInputDoublePressCount == baseDouble);
    assert(zilyInputLastKeyId == ZILY_INPUT_KEY_ENCODER);
    assert(zilyInputLastAction == ZILY_INPUT_ACTION_SINGLE);

    Poll(emit + 1000U);
    assert(capturedKeyCount == 1U);
}

/* ---- Scenario: two clicks inside 280 ms emit only DOUBLE. ---- */
static void TestDoubleClick(void)
{
    InstallStubs();
    (void)ConfirmPress(2000U);             /* press confirmed 2010 */
    (void)ConfirmRelease(2000U);           /* release 2030, single pending */
    SetPush(1U);
    Poll(2100U);                           /* second press sample 1 */
    Poll(2110U);                           /* second press confirmed: cancel single */
    SetPush(0U);
    Poll(2120U);                           /* release sample 1 */
    Poll(2130U);                           /* release confirmed -> DOUBLE */

    assert(capturedKeyCount == 1U);
    assert(capturedKeys[0].keyId == ZILY_INPUT_KEY_ENCODER);
    assert(capturedKeys[0].action == ZILY_INPUT_ACTION_DOUBLE);
    assert(zilyInputKeyEventCount == baseKeyEvent + 1U);
    assert(zilyInputDoublePressCount == baseDouble + 1U);
    assert(zilyInputLastAction == ZILY_INPUT_ACTION_DOUBLE);

    /* The cancelled single click must never fire later. */
    Poll(2600U);
    Poll(3000U);
    assert(capturedKeyCount == 1U);
}

/* ---- Scenario: a second click after the window is a separate SINGLE. ---- */
static void TestTwoSeparatedClicks(void)
{
    uint32_t firstEmit;
    uint32_t secondEmit;

    InstallStubs();
    firstEmit = OneClick(3000U);
    Poll(firstEmit);
    assert(capturedKeyCount == 1U);
    assert(capturedKeys[0].action == ZILY_INPUT_ACTION_SINGLE);

    /* Second click well after the first window. */
    secondEmit = OneClick(firstEmit + 500U);
    Poll(secondEmit);
    assert(capturedKeyCount == 2U);
    assert(capturedKeys[1].action == ZILY_INPUT_ACTION_SINGLE);
    assert(zilyInputDoublePressCount == baseDouble);
    assert(zilyInputKeyEventCount == baseKeyEvent + 2U);
}

/* ---- Scenario: one press sample does not confirm a press. ---- */
static void TestDebounceSingleSampleNoEvent(void)
{
    InstallStubs();

    SetPush(1U);
    Poll(4000U);
    SetPush(0U);
    Poll(4010U);
    Poll(4020U);
    assert(capturedKeyCount == 0U);

    /* Bounce: 1,0,1,1,0,0 - only two consecutive samples confirm an edge. */
    SetPush(1U);
    Poll(4030U);
    SetPush(0U);
    Poll(4040U);
    SetPush(1U);
    Poll(4050U);
    Poll(4060U);
    SetPush(0U);
    Poll(4070U);
    Poll(4080U);
    assert(capturedKeyCount == 0U);       /* single still waiting for the window */

    Poll(4080U + ZILY_INPUT_DOUBLE_PRESS_MS);
    assert(capturedKeyCount == 1U);
    assert(capturedKeys[0].action == ZILY_INPUT_ACTION_SINGLE);
}

/* ---- Scenario: bouncy release does not create a second click/double. ---- */
static void TestBouncingRelease(void)
{
    InstallStubs();

    (void)ConfirmPress(5000U);            /* press confirmed 5010 */
    SetPush(0U);
    Poll(5020U);                          /* release bounce 1 */
    SetPush(1U);
    Poll(5030U);
    SetPush(0U);
    Poll(5040U);
    Poll(5050U);                          /* release confirmed here */
    assert(capturedKeyCount == 0U);

    Poll(5050U + ZILY_INPUT_DOUBLE_PRESS_MS);
    assert(capturedKeyCount == 1U);
    assert(capturedKeys[0].action == ZILY_INPUT_ACTION_SINGLE);
    assert(zilyInputDoublePressCount == baseDouble);
}

/* ---- Scenario: a long hold has no action; release still emits SINGLE. ---- */
static void TestLongHoldHasNoAction(void)
{
    InstallStubs();

    (void)ConfirmPress(6000U);            /* press confirmed 6010 */
    SetPush(1U);
    Poll(7000U);
    Poll(7200U);
    assert(capturedKeyCount == 0U);       /* no long-press event in 0-9A */

    SetPush(0U);
    Poll(7210U);
    Poll(7220U);                          /* release confirmed */
    assert(capturedKeyCount == 0U);

    Poll(7220U + ZILY_INPUT_DOUBLE_PRESS_MS);
    assert(capturedKeyCount == 1U);
    assert(capturedKeys[0].action == ZILY_INPUT_ACTION_SINGLE);
}

/* ---- Scenario: the double-click deadline is wrap-around safe. ---- */
static void TestDoubleWindowWraparound(void)
{
    InstallStubs();

    (void)ConfirmPress(0xFFFFFFE0U);      /* press confirmed 0xFFFFFFEA */
    SetPush(0U);
    Poll(0xFFFFFFF4U);                    /* release sample 1 */
    Poll(0xFFFFFFFEU);                    /* release sample 2 -> deadline wraps to 0x116 */
    assert(capturedKeyCount == 0U);

    Poll(0xFFFFFFFEU + ZILY_INPUT_DOUBLE_PRESS_MS - 10U);
    assert(capturedKeyCount == 0U);
    Poll(0xFFFFFFFEU + ZILY_INPUT_DOUBLE_PRESS_MS);
    assert(capturedKeyCount == 1U);
    assert(capturedKeys[0].action == ZILY_INPUT_ACTION_SINGLE);
}

/* ---- Scenario: encoder detents, direction, remainder, clamp. ---- */
static void TestEncoderDetents(void)
{
    InstallStubs();
    SetEncoder(4);
    Poll(8000U);
    assert(capturedEncoderCount == 1U && capturedEncoder[0] == 1);
    assert(zilyInputEncoderEventCount == baseEncoderEvent + 1U);
    assert(zilyInputLastEncoderSteps == 1);

    InstallStubs();
    SetEncoder(-4);
    Poll(8100U);
    assert(capturedEncoderCount == 1U && capturedEncoder[0] == -1);

    InstallStubs();
    SetEncoder(3);
    Poll(8200U);
    assert(capturedEncoderCount == 0U);
    SetEncoder(1);
    Poll(8210U);
    assert(capturedEncoderCount == 1U && capturedEncoder[0] == 1);

    InstallStubs();
    SetEncoder(-3);
    Poll(8300U);
    assert(capturedEncoderCount == 0U);
    SetEncoder(-1);
    Poll(8310U);
    assert(capturedEncoderCount == 1U && capturedEncoder[0] == -1);

    InstallStubs();
    SetEncoder(8);
    Poll(8400U);
    assert(capturedEncoderCount == 1U && capturedEncoder[0] == 2);

    InstallStubs();
    SetEncoder((int16_t)512);
    Poll(8500U);
    assert(capturedEncoderCount == 1U && capturedEncoder[0] == 127);
    assert(zilyInputLastEncoderSteps == 127);

    InstallStubs();
    SetEncoder((int16_t)-512);
    Poll(8600U);
    assert(capturedEncoderCount == 1U && capturedEncoder[0] == -127);

    InstallStubs();
    SetEncoder(0);
    Poll(8700U);
    Poll(8710U);
    assert(capturedEncoderCount == 0U);
}

/* ---- Scenario: sink failures are counted, successful events are not. ---- */
static void TestSendFailures(void)
{
    InstallStubs();
    sinkKeyResult = 0U;
    (void)ConfirmPress(9000U);
    (void)ConfirmRelease(9000U);
    Poll(9000U + 30U + ZILY_INPUT_DOUBLE_PRESS_MS);
    assert(sinkKeyCalls == 1U);
    assert(zilyInputKeyEventCount == baseKeyEvent);
    assert(zilyInputEventSendFailCount == baseSendFail + 1U);

    InstallStubs();
    sinkEncoderResult = 0U;
    SetEncoder(4);
    Poll(9100U);
    assert(zilyInputEncoderEventCount == baseEncoderEvent);
    assert(zilyInputEventSendFailCount == baseSendFail + 1U);
    assert(zilyInputLastEncoderSteps == baseLastEncoderSteps);

    /* A failed DOUBLE still counts as an attempted double click. */
    InstallStubs();
    sinkKeyResult = 0U;
    (void)ConfirmPress(9200U);
    (void)ConfirmRelease(9200U);
    SetPush(1U);
    Poll(9300U);
    Poll(9310U);
    SetPush(0U);
    Poll(9320U);
    Poll(9330U);
    assert(zilyInputDoublePressCount == baseDouble + 1U);
    assert(zilyInputKeyEventCount == baseKeyEvent);
    assert(zilyInputEventSendFailCount == baseSendFail + 1U);
}

/* ---- Scenario: NULL / partial contracts make Poll a safe no-op. ---- */
static void TestNullConfiguration(void)
{
    ResetCapture();
    ZilyInputServiceInit(NULL, NULL);
    SnapshotCounters();
    Poll(10000U);
    assert(readPushCalls == 0U && readEncoderCalls == 0U);
    assert(zilyInputPollCount == basePoll);

    ResetCapture();
    ZilyInputServiceInit(&stubHardware, NULL);
    SnapshotCounters();
    Poll(10100U);
    assert(readPushCalls == 0U && zilyInputPollCount == basePoll);

    ResetCapture();
    ZilyInputServiceInit(NULL, &stubSink);
    SnapshotCounters();
    Poll(10200U);
    assert(readPushCalls == 0U && zilyInputPollCount == basePoll);

    ResetCapture();
    ZilyInputServiceInit(&hwNullPush, &stubSink);
    SnapshotCounters();
    Poll(10300U);
    assert(readPushCalls == 0U && zilyInputPollCount == basePoll);

    ResetCapture();
    ZilyInputServiceInit(&hwNullEncoder, &stubSink);
    SnapshotCounters();
    Poll(10400U);
    assert(readPushCalls == 0U && zilyInputPollCount == basePoll);

    InstallStubs();
    Poll(OneClick(10500U));
    assert(capturedKeyCount == 1U);
}

int main(void)
{
    TestFirstPollAndTimeGate();
    TestTimeGateWraparound();
    TestSingleClick();
    TestDoubleClick();
    TestTwoSeparatedClicks();
    TestDebounceSingleSampleNoEvent();
    TestBouncingRelease();
    TestLongHoldHasNoAction();
    TestDoubleWindowWraparound();
    TestEncoderDetents();
    TestSendFailures();
    TestNullConfiguration();
    puts("Input service tests passed");
    return 0;
}