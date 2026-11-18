#include "zily_usart.h"

#include <stddef.h>

#include "stm32f10x.h"

#define USART1_BAUD_RATE          115200U
/* Per flag, in status-register reads. Also works before SysTick starts. */
#define USART1_TX_POLL_LIMIT       10000U

static uint8_t WaitForTxFlag(uint32_t flag)
{
    uint32_t polls;

    for (polls = 0U; polls < USART1_TX_POLL_LIMIT; ++polls)
    {
        if ((USART1->SR & flag) != 0U)
        {
            return 1U;
        }
    }

    return 0U;
}

static uint8_t WriteTxData(uint8_t data)
{
    if (WaitForTxFlag(USART_SR_TXE) == 0U)
    {
        return 0U;
    }

    /* The SR read followed by this DR write also clears TC. */
    USART1->DR = data;
    return 1U;
}

void ZILY_USART1_Init(void)
{
    const uint32_t ppre2 = (RCC->CFGR & RCC_CFGR_PPRE2) >> 11U;
    const uint32_t pclk2 = SystemCoreClock >> ((ppre2 < 4U) ? 0U : ppre2 - 3U);

    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_USART1EN;
    (void)RCC->APB2ENR;

    /* Reset only USART1. Reset framing is 8N1 with no flow control. */
    RCC->APB2RSTR |= RCC_APB2RSTR_USART1RST;
    RCC->APB2RSTR &= ~RCC_APB2RSTR_USART1RST;

    /* BRR encodes 16 * USARTDIV. Round PCLK2 / baud to the nearest integer. */
    USART1->BRR = (pclk2 + USART1_BAUD_RATE / 2U) / USART1_BAUD_RATE;
    USART1->CR1 = USART_CR1_UE | USART_CR1_TE;

    /* Use the reset pin mapping. PA9 is AF push-pull at 2 MHz, PA10 is
     * input with pull-up. Only the PA9 and PA10 configuration bits change. */
    GPIOA->BSRR = GPIO_BSRR_BS10;
    GPIOA->CRH = (GPIOA->CRH & ~(GPIO_CRH_CNF9 | GPIO_CRH_MODE9 |
                                 GPIO_CRH_CNF10 | GPIO_CRH_MODE10)) |
                  GPIO_CRH_CNF9_1 | GPIO_CRH_MODE9_1 | GPIO_CRH_CNF10_1;
}

uint8_t ZILY_USART1_SendByte(uint8_t data)
{
    return ZILY_USART1_SendData(&data, 1U);
}

uint8_t ZILY_USART1_SendData(const uint8_t *data, uint16_t length)
{
    uint16_t index;

    if (data == NULL)
    {
        return 0U;
    }

    for (index = 0U; index < length; ++index)
    {
        if (WriteTxData(data[index]) == 0U)
        {
            return 0U;
        }
    }

    return (length == 0U) ? 1U : WaitForTxFlag(USART_SR_TC);
}

uint8_t ZILY_USART1_SendString(const char *str)
{
    if (str == NULL)
    {
        return 0U;
    }

    if (*str == '\0')
    {
        return 1U;
    }

    while (*str != '\0')
    {
        if (WriteTxData((uint8_t)*str) == 0U)
        {
            return 0U;
        }
        ++str;
    }

    return WaitForTxFlag(USART_SR_TC);
}
