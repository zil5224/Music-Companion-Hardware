#ifndef ZILY_KEY_H
#define ZILY_KEY_H

#include <stdint.h>

/* 0-9A encoder-only input: the push button built into the rotary encoder is on
 * PA5, configured as an input with the internal pull-up. Pressing the knob
 * pulls PA5 low. KEY1/KEY2 (PB1/PB11) were removed from this phase. */
void ZILY_KEY_Init(void);

/* 1 while the encoder knob is pressed down, 0 otherwise. */
uint8_t ZILY_KEY_IsEncoderPushPressed(void);

#endif
