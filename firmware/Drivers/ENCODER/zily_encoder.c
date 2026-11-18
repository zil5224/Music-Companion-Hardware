#include "zily_encoder.h"

#include "stm32f10x.h"

/* Input with pull-up/down is CNF=10, MODE=00, i.e. one 0x8 nibble. */
#define ENCODER_INPUT_PULL_UP_NIBBLE  0x8U
#define ENCODER_PA6_NIBBLE_SHIFT      24U
#define ENCODER_PA7_NIBBLE_SHIFT      28U
#define ENCODER_PIN_NIBBLE_MASK       0x0FU

/* Input filter 0xF: sample at fDTS/32 with N=8, the strongest on-chip filter.
 * It suppresses contact bounce on the mechanical encoder. */
#define ENCODER_INPUT_FILTER          0xFU

void ZILY_ENCODER_Init(void)
{
    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN;
    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
    (void)RCC->APB2ENR;
    (void)RCC->APB1ENR;

    /* PA6/PA7 are TIM3_CH1/TIM3_CH2 on the reset pin mapping (no AFIO remap).
     * The timer samples the pins itself once CC1S/CC2S select TI1/TI2, so the
     * GPIO mode is plain pulled-up input. */
    GPIOA->BSRR = (1UL << 6) | (1UL << 7);
    GPIOA->CRL = (GPIOA->CRL &
                  ~((ENCODER_PIN_NIBBLE_MASK << ENCODER_PA6_NIBBLE_SHIFT) |
                    (ENCODER_PIN_NIBBLE_MASK << ENCODER_PA7_NIBBLE_SHIFT))) |
                 (ENCODER_INPUT_PULL_UP_NIBBLE << ENCODER_PA6_NIBBLE_SHIFT) |
                 (ENCODER_INPUT_PULL_UP_NIBBLE << ENCODER_PA7_NIBBLE_SHIFT);

    RCC->APB1RSTR |= RCC_APB1RSTR_TIM3RST;
    RCC->APB1RSTR &= ~RCC_APB1RSTR_TIM3RST;

    /* 16-bit free-running counter; PSC=0 and ARR=0xFFFF keep the full range. */
    TIM3->CR1 = 0U;
    TIM3->PSC = 0U;
    TIM3->ARR = 0xFFFFU;
    TIM3->CNT = 0U;

    /* CC1S=01 (IC1 on TI1) and CC2S=01 (IC2 on TI2); both inputs filtered. */
    TIM3->CCMR1 = TIM_CCMR1_CC1S_0 | TIM_CCMR1_CC2S_0 |
                  (uint16_t)(ENCODER_INPUT_FILTER << 4U) |
                  (uint16_t)(ENCODER_INPUT_FILTER << 12U);
    TIM3->CCER = TIM_CCER_CC1E | TIM_CCER_CC2E;
    /* SMS=011: encoder mode 3, count on both TI1 and TI2 edges. */
    TIM3->SMCR = TIM_SMCR_SMS_0 | TIM_SMCR_SMS_1;
    TIM3->EGR = TIM_EGR_UG;
    TIM3->SR = 0U;
    TIM3->CR1 = TIM_CR1_CEN;
}

int16_t ZILY_ENCODER_TakeDelta(void)
{
    const uint16_t raw = (uint16_t)TIM3->CNT;

    TIM3->CNT = 0U;

    /* Two's complement wrap keeps a small negative delta correct on ARM. */
    return (int16_t)raw;
}
