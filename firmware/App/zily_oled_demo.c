#include "zily_oled_demo.h"

#include "stm32f10x.h"
#include "zily_oled.h"

#define PATTERN_HOLD_MS      300U
#define PANEL_POWER_UP_MS    50U
#define BITMAP_X             57U
#define BITMAP_Y             29U
#define BITMAP_WIDTH         13U
#define BITMAP_HEIGHT        9U

static void Hold(uint32_t milliseconds)
{
    const uint32_t cycles = (SystemCoreClock / 1000U) * milliseconds;
    const uint32_t start = DWT->CYCCNT;
    uint32_t polls;

    /* The poll cap still ends the delay if the cycle counter is unavailable. */
    for (polls = 0U; polls < cycles; ++polls)
    {
        if ((uint32_t)(DWT->CYCCNT - start) >= cycles)
        {
            break;
        }
    }
}

static ZilyI2cStatus Show(void)
{
    const ZilyI2cStatus status = ZILY_OLED_Flush();

    if (status == ZILY_I2C_OK)
    {
        Hold(PATTERN_HOLD_MS);
    }
    return status;
}

static void DrawCheckerboard(void)
{
    uint16_t x;
    uint16_t y;

    for (y = 0U; y < ZILY_DISPLAY_HEIGHT; ++y)
    {
        for (x = 0U; x < ZILY_DISPLAY_WIDTH; ++x)
        {
            ZILY_OLED_SetPixel(x, y, ((x ^ y) & 1U) == 0U);
        }
    }
}

static void DrawPositionMarks(void)
{
    const uint16_t centerX = ZILY_DISPLAY_WIDTH / 2U;
    const uint16_t centerY = ZILY_DISPLAY_HEIGHT / 2U;
    const uint16_t right = ZILY_DISPLAY_WIDTH - 1U;
    const uint16_t bottom = ZILY_DISPLAY_HEIGHT - 1U;

    ZILY_OLED_Clear();
    /* Asymmetric corner marks make orientation and clipping visible. */
    ZILY_OLED_DrawLine(0U, 0U, 7U, 0U, 1U);
    ZILY_OLED_DrawLine(right, 0U, right, 7U, 1U);
    ZILY_OLED_DrawLine(0U, bottom, 0U, bottom - 7U, 1U);
    ZILY_OLED_DrawLine(right, bottom, right - 7U, bottom, 1U);
    ZILY_OLED_DrawLine(centerX - 5U, centerY, centerX + 5U, centerY, 1U);
    ZILY_OLED_DrawLine(centerX, centerY - 5U, centerX, centerY + 5U, 1U);
}

static void RunPatterns(void)
{
    /* 13x9 arrow with row padding. Placement straddles an OLED page boundary. */
    static const uint8_t arrow[] =
    {
        0x02U, 0x00U, 0x03U, 0x00U, 0x03U, 0x80U,
        0xFFU, 0xC0U, 0xFFU, 0xE0U, 0xFFU, 0xC0U,
        0x03U, 0x80U, 0x03U, 0x00U, 0x02U, 0x00U
    };
    uint8_t repeat;

    Hold(PANEL_POWER_UP_MS);
    if (ZILY_OLED_Init() != ZILY_I2C_OK)
    {
        return;
    }
    Hold(PATTERN_HOLD_MS);
    ZILY_OLED_FillRect(0U, 0U, ZILY_DISPLAY_WIDTH, ZILY_DISPLAY_HEIGHT, 1U);
    if (Show() != ZILY_I2C_OK)
    {
        return;
    }
    ZILY_OLED_Clear();
    ZILY_OLED_DrawRect(0U, 0U, ZILY_DISPLAY_WIDTH, ZILY_DISPLAY_HEIGHT, 1U);
    if (Show() != ZILY_I2C_OK)
    {
        return;
    }
    DrawCheckerboard();
    if (Show() != ZILY_I2C_OK)
    {
        return;
    }
    DrawPositionMarks();
    if (Show() != ZILY_I2C_OK)
    {
        return;
    }

    ZILY_OLED_Clear();
    ZILY_OLED_DrawRect(0U, 0U, ZILY_DISPLAY_WIDTH, ZILY_DISPLAY_HEIGHT, 1U);
    if (ZILY_OLED_Flush() != ZILY_I2C_OK)
    {
        return;
    }
    for (repeat = 0U; repeat < 3U; ++repeat)
    {
        ZILY_OLED_FillRect(BITMAP_X, BITMAP_Y, BITMAP_WIDTH, BITMAP_HEIGHT, 0U);
        if (ZILY_OLED_FlushRegion(BITMAP_X, BITMAP_Y, BITMAP_WIDTH, BITMAP_HEIGHT) != ZILY_I2C_OK)
        {
            return;
        }
        (void)ZILY_OLED_DrawBitmap(BITMAP_X, BITMAP_Y, BITMAP_WIDTH, BITMAP_HEIGHT,
                                  arrow, sizeof(arrow));
        if (ZILY_OLED_FlushRegion(BITMAP_X, BITMAP_Y, BITMAP_WIDTH, BITMAP_HEIGHT) != ZILY_I2C_OK)
        {
            return;
        }
    }
}

void ZilyOledRunStartupTest(void)
{
    const uint32_t demcr = CoreDebug->DEMCR;
    uint32_t dwtControl;

    CoreDebug->DEMCR = demcr | CoreDebug_DEMCR_TRCENA_Msk;
    dwtControl = DWT->CTRL;
    DWT->CTRL = dwtControl | DWT_CTRL_CYCCNTENA_Msk;
    RunPatterns();
    DWT->CTRL = dwtControl;
    CoreDebug->DEMCR = demcr;
}
