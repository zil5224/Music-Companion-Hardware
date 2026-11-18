#ifndef ZILY_ENCODER_H
#define ZILY_ENCODER_H

#include <stdint.h>

/* 0-9A board wiring (confirmed 2026-11-16):
 *   encoder A/B = PA6/PA7 on the TIM3 encoder interface.
 * A 16-bit hardware counter accumulates both edges; the input service converts
 * the accumulated counts into detents (4 counts per mechanical detent). */

/* Configure PA6/PA7 as pulled-up inputs and start TIM3 in encoder mode 3
 * (count on every valid edge of TI1 and TI2). */
void ZILY_ENCODER_Init(void);

/* Returns the signed count delta since the previous call and clears TIM3 CNT.
 * Call it from one task context only. A count arriving between the read and the
 * reset is lost, which is harmless at the 10 ms polling cadence (16-bit wrap
 * would need more than 32k counts in one poll). */
int16_t ZILY_ENCODER_TakeDelta(void);

#endif
