#include "zily_key.h"

#include "stm32f10x.h"

/* Input with pull-up/down is CNF=10, MODE=00, i.e. one 0x8 nibble. */
#define KEY_INPUT_PULL_UP_NIBBLE  0x8U
#define KEY_PA5_NIBBLE_SHIFT      20U
#define KEY_PIN_NIBBLE_MASK       0x0FU

void ZILY_KEY_Init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;
    (void)RCC->APB2ENR;

    /* ODR drives the pull-up selection while MODE is input. */
    GPIOA->BSRR = (1UL << 5);
    GPIOA->CRL = (GPIOA->CRL &
                  ~(KEY_PIN_NIBBLE_MASK << KEY_PA5_NIBBLE_SHIFT)) |
                 (KEY_INPUT_PULL_UP_NIBBLE << KEY_PA5_NIBBLE_SHIFT);
}

uint8_t ZILY_KEY_IsEncoderPushPressed(void)
{
    return (uint8_t)(((GPIOA->IDR & (1UL << 5)) == 0UL) ? 1U : 0U);
}
