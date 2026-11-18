#ifndef ZILY_OLED_H
#define ZILY_OLED_H

#include "../I2C/zily_i2c.h"
#include "../zily_display_board.h"

/* One caller owns the bus and framebuffer. No API may be called from an ISR.
 * Init sets up I2C, clears the display RAM, then enables the panel. */
ZilyI2cStatus ZILY_OLED_Init(void);
void ZILY_OLED_Clear(void);

/* Transfer all pages. A failed transfer can be retried with another Flush. */
ZilyI2cStatus ZILY_OLED_Flush(void);

/* Transfer the clipped rectangle's columns on each intersecting 8-row page.
 * Boundary bytes come from the same framebuffer, including pixels outside the
 * rectangle on those pages. Empty/off-screen rectangles are no-ops. */
ZilyI2cStatus ZILY_OLED_FlushRegion(uint16_t x, uint16_t y,
                                   uint16_t width, uint16_t height);

/* Off-screen coordinates are ignored. A nonzero value lights the pixel. */
void ZILY_OLED_SetPixel(uint16_t x, uint16_t y, uint8_t on);

/* Draw a line including both endpoints. Endpoints must be on-screen. */
void ZILY_OLED_DrawLine(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1, uint8_t on);

/* Draw the visible part of an outline or filled rectangle. A zero width or
 * height is a no-op. Pass on=0 to erase pixels in the region. */
void ZILY_OLED_DrawRect(uint16_t x, uint16_t y, uint16_t width, uint16_t height, uint8_t on);
void ZILY_OLED_FillRect(uint16_t x, uint16_t y, uint16_t width, uint16_t height, uint8_t on);

/* Opaque 1bpp bitmap in row order, MSB = leftmost pixel, 1 = on, 0 = off.
 * Each row has ceil(width / 8) bytes. The right/bottom edges are clipped.
 * Returns 0 for a null pointer, zero size or insufficient source length.
 * A valid bitmap fully off-screen returns 1 and draws nothing. */
uint8_t ZILY_OLED_DrawBitmap(uint16_t x, uint16_t y, uint16_t width,
                            uint16_t height, const uint8_t *data, size_t length);

extern volatile uint32_t zilyOledInitFailed;
extern volatile uint32_t zilyOledI2cErrorCount;
extern volatile uint32_t zilyOledTimeoutCount;
/* Completed full or nonempty regional refreshes. */
extern volatile uint32_t zilyOledFlushCount;
/* Most recent error (ZilyI2cStatus). A subsequent success keeps this value. */
extern volatile uint32_t zilyOledLastError;

#endif
