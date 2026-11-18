#include "zily_oled.h"

#include <string.h>

#if (ZILY_DISPLAY_WIDTH != 128U) || (ZILY_DISPLAY_HEIGHT != 64U)
    #error This SSD1306 initialization sequence is for the 128x64 panel profile
#endif

#define OLED_PAGE_COUNT      (ZILY_DISPLAY_HEIGHT / 8U)
#define OLED_COMMAND         0x00U
#define OLED_DATA            0x40U

static uint8_t framebuffer[OLED_PAGE_COUNT][ZILY_DISPLAY_WIDTH];

volatile uint32_t zilyOledInitFailed;
volatile uint32_t zilyOledI2cErrorCount;
volatile uint32_t zilyOledTimeoutCount;
volatile uint32_t zilyOledFlushCount;
volatile uint32_t zilyOledLastError;

static ZilyI2cStatus RecordStatus(ZilyI2cStatus status)
{
    if (status != ZILY_I2C_OK)
    {
        ++zilyOledI2cErrorCount;
        zilyOledLastError = (uint32_t)status;
        if (status == ZILY_I2C_TIMEOUT)
        {
            ++zilyOledTimeoutCount;
        }
    }
    return status;
}

static ZilyI2cStatus Write(uint8_t prefix, const uint8_t *data, size_t length)
{
    return RecordStatus(ZILY_I2C_Write(ZILY_DISPLAY_ADDRESS, prefix, data, length));
}

ZilyI2cStatus ZILY_OLED_Init(void)
{
    static const uint8_t initCommands[] =
    {
        0xAEU,        /* Display off while configuring and clearing GDDRAM. */
        0xD5U, 0x80U, /* Clock divide and oscillator. */
        0xA8U, 0x3FU, /* 64 multiplexed rows. */
        0xD3U, 0x00U, /* Display offset zero. */
        0x40U,        /* Display start line zero. */
        0x8DU, 0x14U, /* Enable the internal charge pump. */
        0x20U, 0x02U, /* Page addressing. */
        0xA1U, 0xC8U, /* Segment remap and COM scan direction. */
        0xDAU, 0x12U, /* Alternative COM pin configuration for 128x64. */
        0x81U, 0x7FU, /* Contrast. */
        0xD9U, 0xF1U, /* Pre-charge for internal pump operation. */
        0xDBU, 0x20U, /* VCOMH deselect level. */
        0x2EU,        /* Stop scrolling. */
        0xA4U, 0xA6U  /* Show RAM in normal (non-inverted) mode. */
    };
    static const uint8_t displayOn = 0xAFU;
    ZilyI2cStatus status = RecordStatus(ZILY_I2C_Init());

    if (status == ZILY_I2C_OK)
    {
        status = Write(OLED_COMMAND, initCommands, sizeof(initCommands));
    }
    if (status == ZILY_I2C_OK)
    {
        ZILY_OLED_Clear();
        status = ZILY_OLED_Flush();
    }
    if (status == ZILY_I2C_OK)
    {
        status = Write(OLED_COMMAND, &displayOn, 1U);
    }
    if (status != ZILY_I2C_OK)
    {
        ++zilyOledInitFailed;
    }
    return status;
}

void ZILY_OLED_Clear(void)
{
    (void)memset(framebuffer, 0, sizeof(framebuffer));
}

static uint8_t ClipRegion(uint16_t x, uint16_t y, uint16_t *width, uint16_t *height)
{
    if ((x >= ZILY_DISPLAY_WIDTH) || (y >= ZILY_DISPLAY_HEIGHT) ||
        (*width == 0U) || (*height == 0U))
    {
        return 0U;
    }
    if (*width > ZILY_DISPLAY_WIDTH - x)
    {
        *width = (uint16_t)(ZILY_DISPLAY_WIDTH - x);
    }
    if (*height > ZILY_DISPLAY_HEIGHT - y)
    {
        *height = (uint16_t)(ZILY_DISPLAY_HEIGHT - y);
    }
    return 1U;
}

ZilyI2cStatus ZILY_OLED_Flush(void)
{
    return ZILY_OLED_FlushRegion(0U, 0U, ZILY_DISPLAY_WIDTH, ZILY_DISPLAY_HEIGHT);
}

ZilyI2cStatus ZILY_OLED_FlushRegion(uint16_t x, uint16_t y,
                                   uint16_t width, uint16_t height)
{
    uint8_t position[3];
    uint8_t page;
    uint8_t lastPage;

    if (ClipRegion(x, y, &width, &height) == 0U)
    {
        return ZILY_I2C_OK;
    }
    position[1] = (uint8_t)(x & 0x0FU);
    position[2] = (uint8_t)(0x10U | (x >> 4U));
    lastPage = (uint8_t)((y + height - 1U) / 8U);
    for (page = (uint8_t)(y / 8U); page <= lastPage; ++page)
    {
        ZilyI2cStatus status;

        position[0] = (uint8_t)(0xB0U | page);
        status = Write(OLED_COMMAND, position, sizeof(position));

        if (status == ZILY_I2C_OK)
        {
            status = Write(OLED_DATA, &framebuffer[page][x], width);
        }
        if (status != ZILY_I2C_OK)
        {
            return status;
        }
    }
    ++zilyOledFlushCount;
    return ZILY_I2C_OK;
}

void ZILY_OLED_SetPixel(uint16_t x, uint16_t y, uint8_t on)
{
    uint8_t *cell;
    uint8_t mask;

    if ((x >= ZILY_DISPLAY_WIDTH) || (y >= ZILY_DISPLAY_HEIGHT))
    {
        return;
    }
    cell = &framebuffer[y / 8U][x];
    mask = (uint8_t)(1U << (y % 8U));
    if (on != 0U)
    {
        *cell |= mask;
    }
    else
    {
        *cell &= (uint8_t)~mask;
    }
}

void ZILY_OLED_DrawLine(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1, uint8_t on)
{
    int x = x0;
    int y = y0;
    const int stepX = (x0 <= x1) ? 1 : -1;
    const int stepY = (y0 <= y1) ? 1 : -1;
    const int dx = ((int)x1 - x0) * stepX;
    const int dy = ((int)y0 - y1) * stepY;
    int error = dx + dy;

    if ((x0 >= ZILY_DISPLAY_WIDTH) || (x1 >= ZILY_DISPLAY_WIDTH) ||
        (y0 >= ZILY_DISPLAY_HEIGHT) || (y1 >= ZILY_DISPLAY_HEIGHT))
    {
        return;
    }
    for (;;)
    {
        const int doubledError = 2 * error;

        ZILY_OLED_SetPixel((uint16_t)x, (uint16_t)y, on);
        if ((x == x1) && (y == y1))
        {
            break;
        }
        if (doubledError >= dy)
        {
            error += dy;
            x += stepX;
        }
        if (doubledError <= dx)
        {
            error += dx;
            y += stepY;
        }
    }
}

void ZILY_OLED_FillRect(uint16_t x, uint16_t y, uint16_t width, uint16_t height, uint8_t on)
{
    uint16_t row;
    uint16_t column;

    if (ClipRegion(x, y, &width, &height) == 0U)
    {
        return;
    }
    for (row = y; row < y + height; ++row)
    {
        for (column = x; column < x + width; ++column)
        {
            ZILY_OLED_SetPixel(column, row, on);
        }
    }
}

void ZILY_OLED_DrawRect(uint16_t x, uint16_t y, uint16_t width, uint16_t height, uint8_t on)
{
    if ((x >= ZILY_DISPLAY_WIDTH) || (y >= ZILY_DISPLAY_HEIGHT) ||
        (width == 0U) || (height == 0U))
    {
        return;
    }
    ZILY_OLED_FillRect(x, y, width, 1U, on);
    ZILY_OLED_FillRect(x, y, 1U, height, on);
    if (width <= ZILY_DISPLAY_WIDTH - x)
    {
        ZILY_OLED_FillRect((uint16_t)(x + width - 1U), y, 1U, height, on);
    }
    if (height <= ZILY_DISPLAY_HEIGHT - y)
    {
        ZILY_OLED_FillRect(x, (uint16_t)(y + height - 1U), width, 1U, on);
    }
}

uint8_t ZILY_OLED_DrawBitmap(uint16_t x, uint16_t y, uint16_t width,
                            uint16_t height, const uint8_t *data, size_t length)
{
    const size_t stride = ((size_t)width + 7U) / 8U;
    uint16_t row;
    uint16_t column;

    if ((data == NULL) || (stride == 0U) || (height == 0U) ||
        ((size_t)height > length / stride))
    {
        return 0U;
    }
    if ((x >= ZILY_DISPLAY_WIDTH) || (y >= ZILY_DISPLAY_HEIGHT))
    {
        return 1U;
    }
    for (row = 0U; (row < height) && (y + row < ZILY_DISPLAY_HEIGHT); ++row)
    {
        const uint8_t *source = data + (size_t)row * stride;

        for (column = 0U; (column < width) && (x + column < ZILY_DISPLAY_WIDTH); ++column)
        {
            const uint8_t on = source[column / 8U] & (0x80U >> (column % 8U));

            ZILY_OLED_SetPixel((uint16_t)(x + column), (uint16_t)(y + row), on);
        }
    }
    return 1U;
}
