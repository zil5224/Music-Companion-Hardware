#include "zily_oled.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static uint8_t pages[8][128];
static unsigned int writes;
static unsigned int failOnWrite;
static unsigned int page;
static unsigned int column;
static unsigned int dataBytes;
static uint8_t expectingPageData;
static ZilyI2cStatus busStatus;
static ZilyI2cStatus writeFailure;

ZilyI2cStatus ZILY_I2C_Init(void)
{
    writes = 0U;
    dataBytes = 0U;
    expectingPageData = 0U;
    return busStatus;
}

ZilyI2cStatus ZILY_I2C_Write(uint8_t address, uint8_t prefix,
                            const uint8_t *data, size_t length)
{
    assert(address == 0x3CU);
    ++writes;
    if (writes == failOnWrite)
    {
        return writeFailure;
    }
    if (prefix == 0x40U)
    {
        assert(expectingPageData && length > 0U && length <= sizeof(pages[0]) - column);
        memcpy(&pages[page][column], data, length);
        dataBytes += (unsigned int)length;
        expectingPageData = 0U;
    }
    else
    {
        assert(prefix == 0U);
        if (length == 3U)
        {
            assert((data[0] >= 0xB0U) && (data[0] <= 0xB7U));
            assert(data[1] <= 0x0FU && data[2] >= 0x10U && data[2] <= 0x17U);
            page = data[0] - 0xB0U;
            column = ((data[2] & 0x0FU) << 4U) | data[1];
            expectingPageData = 1U;
        }
        else if (length == 1U)
        {
            assert(writes == 18U && data[0] == 0xAFU);
        }
        else
        {
            assert(writes == 1U && data[0] == 0xAEU);
        }
    }
    return ZILY_I2C_OK;
}

static uint8_t Pixel(unsigned int x, unsigned int y)
{
    return (pages[y / 8U][x] >> (y % 8U)) & 1U;
}

static void CheckSolid(uint8_t expected)
{
    unsigned int x;
    unsigned int y;

    for (y = 0U; y < 8U; ++y)
    {
        for (x = 0U; x < 128U; ++x)
        {
            assert(pages[y][x] == expected);
        }
    }
}

static void CheckPatterns(void)
{
    unsigned int x;
    unsigned int y;

    ZILY_OLED_FillRect(0U, 0U, 128U, 64U, 1U);
    assert(ZILY_OLED_Flush() == ZILY_I2C_OK);
    CheckSolid(0xFFU);

    ZILY_OLED_Clear();
    ZILY_OLED_DrawRect(0U, 0U, 128U, 64U, 1U);
    assert(ZILY_OLED_Flush() == ZILY_I2C_OK);
    for (y = 0U; y < 64U; ++y)
    {
        for (x = 0U; x < 128U; ++x)
        {
            assert(Pixel(x, y) == (x == 0U || x == 127U || y == 0U || y == 63U));
            ZILY_OLED_SetPixel((uint16_t)x, (uint16_t)y, (uint8_t)(((x + y) & 1U) == 0U));
        }
    }
    assert(ZILY_OLED_Flush() == ZILY_I2C_OK);
    for (y = 0U; y < 64U; ++y)
    {
        for (x = 0U; x < 128U; ++x)
        {
            assert(Pixel(x, y) == (((x + y) & 1U) == 0U));
        }
    }
}

static void CheckRegionAndLines(void)
{
    unsigned int beforeWrites;
    unsigned int beforeBytes;
    uint32_t beforeFlushes;

    ZILY_OLED_Clear();
    ZILY_OLED_SetPixel(19U, 7U, 1U);
    ZILY_OLED_SetPixel(19U, 10U, 1U);
    assert(ZILY_OLED_Flush() == ZILY_I2C_OK);
    ZILY_OLED_DrawLine(21U, 9U, 19U, 7U, 1U);
    ZILY_OLED_DrawLine(19U, 8U, 21U, 8U, 1U);
    ZILY_OLED_SetPixel(22U, 8U, 1U);
    ZILY_OLED_SetPixel(19U, 16U, 1U);
    assert(!Pixel(19U, 8U));

    beforeWrites = writes;
    beforeBytes = dataBytes;
    beforeFlushes = zilyOledFlushCount;
    assert(ZILY_OLED_FlushRegion(19U, 7U, 3U, 3U) == ZILY_I2C_OK);
    assert(writes == beforeWrites + 4U && dataBytes == beforeBytes + 6U);
    assert(zilyOledFlushCount == beforeFlushes + 1U);
    assert(Pixel(19U, 7U) && Pixel(20U, 8U) && Pixel(21U, 9U));
    assert(Pixel(19U, 8U) && Pixel(21U, 8U) && !Pixel(20U, 9U));
    assert(Pixel(19U, 10U) && !Pixel(22U, 8U) && !Pixel(19U, 16U));

    ZILY_OLED_FillRect(19U, 7U, 3U, 3U, 0U);
    assert(ZILY_OLED_FlushRegion(19U, 7U, 3U, 3U) == ZILY_I2C_OK);
    assert(!Pixel(19U, 7U) && !Pixel(20U, 8U) && !Pixel(21U, 9U) && Pixel(19U, 10U));

    ZILY_OLED_DrawRect(126U, 62U, 65535U, 65535U, 1U);
    ZILY_OLED_DrawLine(128U, 63U, 126U, 63U, 0U);
    beforeWrites = writes;
    beforeBytes = dataBytes;
    assert(ZILY_OLED_FlushRegion(126U, 62U, 65535U, 65535U) == ZILY_I2C_OK);
    assert(writes == beforeWrites + 2U && dataBytes == beforeBytes + 2U);
    assert(Pixel(126U, 62U) && Pixel(127U, 62U) && Pixel(126U, 63U) && !Pixel(127U, 63U));

    beforeWrites = writes;
    beforeFlushes = zilyOledFlushCount;
    assert(ZILY_OLED_FlushRegion(65535U, 0U, 10U, 10U) == ZILY_I2C_OK);
    assert(ZILY_OLED_FlushRegion(0U, 0U, 10U, 0U) == ZILY_I2C_OK);
    assert(writes == beforeWrites && zilyOledFlushCount == beforeFlushes);
}

static void CheckBitmap(void)
{
    static const uint8_t bitmap[] = {0x81U, 0xFFU, 0x40U, 0x7FU};
    unsigned int repeat;

    for (repeat = 0U; repeat < 3U; ++repeat)
    {
        ZILY_OLED_Clear();
        assert(ZILY_OLED_Flush() == ZILY_I2C_OK);
        CheckSolid(0U);

        ZILY_OLED_SetPixel(0U, 0U, 1U);
        ZILY_OLED_SetPixel(127U, 0U, 1U);
        ZILY_OLED_SetPixel(0U, 63U, 1U);
        ZILY_OLED_SetPixel(127U, 63U, 1U);
        ZILY_OLED_SetPixel(64U, 32U, 1U);
        ZILY_OLED_SetPixel(51U, 7U, 1U);
        ZILY_OLED_SetPixel(128U, 0U, 1U);
        ZILY_OLED_SetPixel(0U, 64U, 1U);
        assert(!ZILY_OLED_DrawBitmap(50U, 7U, 9U, 2U, bitmap, 3U));
        assert(!ZILY_OLED_DrawBitmap(0U, 0U, 1U, 1U, NULL, 1U));
        assert(!ZILY_OLED_DrawBitmap(0U, 0U, 0U, 1U, bitmap, sizeof(bitmap)));
        assert(ZILY_OLED_DrawBitmap(50U, 7U, 9U, 2U, bitmap, sizeof(bitmap)));
        assert(ZILY_OLED_DrawBitmap(126U, 63U, 9U, 2U, bitmap, sizeof(bitmap)));
        assert(ZILY_OLED_DrawBitmap(65535U, 65535U, 9U, 2U, bitmap, sizeof(bitmap)));
        assert(ZILY_OLED_Flush() == ZILY_I2C_OK);
        assert(Pixel(0U, 0U) && Pixel(127U, 0U) && Pixel(0U, 63U) && Pixel(64U, 32U));
        assert(Pixel(50U, 7U) && !Pixel(51U, 7U) && Pixel(57U, 7U) && Pixel(58U, 7U));
        assert(!Pixel(59U, 7U) && !Pixel(50U, 8U) && Pixel(51U, 8U) && !Pixel(58U, 8U));
        assert(Pixel(126U, 63U) && !Pixel(127U, 63U));
        assert(!Pixel(1U, 0U) && !Pixel(0U, 1U));
    }
}

int main(void)
{
    uint32_t flushes;

    memset(pages, 0xFF, sizeof(pages));
    assert(ZILY_OLED_Init() == ZILY_I2C_OK);
    assert(zilyOledFlushCount == 1U && zilyOledInitFailed == 0U);
    assert(zilyOledI2cErrorCount == 0U && zilyOledLastError == ZILY_I2C_OK);
    assert(writes == 18U);
    CheckSolid(0U);
    CheckPatterns();
    CheckBitmap();
    CheckRegionAndLines();

    flushes = zilyOledFlushCount;
    failOnWrite = writes + 2U;
    writeFailure = ZILY_I2C_NACK;
    assert(ZILY_OLED_Flush() == ZILY_I2C_NACK);
    assert(writes == failOnWrite && zilyOledFlushCount == flushes);
    assert(zilyOledLastError == ZILY_I2C_NACK && zilyOledI2cErrorCount == 1U);
    assert(ZILY_OLED_Flush() == ZILY_I2C_OK);
    assert(zilyOledFlushCount == flushes + 1U && zilyOledLastError == ZILY_I2C_NACK);

    busStatus = ZILY_I2C_TIMEOUT;
    assert(ZILY_OLED_Init() == ZILY_I2C_TIMEOUT && writes == 0U);
    assert(zilyOledInitFailed == 1U && zilyOledTimeoutCount == 1U);
    assert(zilyOledI2cErrorCount == 2U && zilyOledLastError == ZILY_I2C_TIMEOUT);

    busStatus = ZILY_I2C_OK;
    failOnWrite = 1U;
    writeFailure = ZILY_I2C_BUS_ERROR;
    assert(ZILY_OLED_Init() == ZILY_I2C_BUS_ERROR && writes == 1U);
    assert(zilyOledInitFailed == 2U && zilyOledI2cErrorCount == 3U);
    assert(zilyOledLastError == ZILY_I2C_BUS_ERROR);
    puts("OLED framebuffer and mock I2C tests passed");
    return 0;
}
