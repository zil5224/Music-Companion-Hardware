/*
 * Adapted for STM32F103C8 from the STM32F1xx DFP 2.2.0 system_stm32f10x.c.
 * Original CMSIS system source, V3.5.0, (C) COPYRIGHT 2011 STMicroelectronics.
 *
 * THE PRESENT FIRMWARE WHICH IS FOR GUIDANCE ONLY AIMS AT PROVIDING CUSTOMERS
 * WITH CODING INFORMATION REGARDING THEIR PRODUCTS IN ORDER FOR THEM TO SAVE
 * TIME. AS A RESULT, STMICROELECTRONICS SHALL NOT BE HELD LIABLE FOR ANY DIRECT,
 * INDIRECT OR CONSEQUENTIAL DAMAGES WITH RESPECT TO ANY CLAIMS ARISING FROM THE
 * CONTENT OF SUCH FIRMWARE AND/OR THE USE MADE BY CUSTOMERS OF THE CODING
 * INFORMATION CONTAINED HEREIN IN CONNECTION WITH THEIR PRODUCTS.
 */
#include "stm32f10x.h"

uint32_t SystemCoreClock = HSI_VALUE;

static const uint8_t AHBPrescTable[16] =
{
    0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 6, 7, 8, 9
};

void SystemInit(void)
{
    /* Reset_Handler calls this before the C runtime initializes RAM. */
    RCC->CR |= RCC_CR_HSION;
    while ((RCC->CR & RCC_CR_HSIRDY) == 0U)
    {
    }

    /* SW=00 requests HSI. Wait for SWS=00 before disabling other sources. */
    RCC->CFGR &= ~RCC_CFGR_SW;
    while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_HSI)
    {
    }

    /* HPRE, PPRE1 and PPRE2 all encode divide-by-1 as zero. */
    RCC->CFGR &= ~(RCC_CFGR_HPRE | RCC_CFGR_PPRE1 | RCC_CFGR_PPRE2);
    RCC->CR &= ~(RCC_CR_PLLON | RCC_CR_CSSON | RCC_CR_HSEON);
    FLASH->ACR &= ~((uint32_t)FLASH_ACR_LATENCY);
    SCB->VTOR = FLASH_BASE;
}

void SystemCoreClockUpdate(void)
{
    const uint32_t cfgr = RCC->CFGR;
    uint32_t sysclk;

    /* Clock calculation from the DFP, specialized for medium-density F103. */
    switch (cfgr & RCC_CFGR_SWS)
    {
        case RCC_CFGR_SWS_HSE:
            sysclk = HSE_VALUE;
            break;

        case RCC_CFGR_SWS_PLL:
            if ((cfgr & RCC_CFGR_PLLSRC) == 0U)
            {
                sysclk = HSI_VALUE / 2U;
            }
            else
            {
                sysclk = HSE_VALUE;
                if ((cfgr & RCC_CFGR_PLLXTPRE) != 0U)
                {
                    sysclk /= 2U;
                }
            }
            sysclk *= ((cfgr & RCC_CFGR_PLLMULL) >> 18U) + 2U;
            break;

        default:
            sysclk = HSI_VALUE;
            break;
    }

    SystemCoreClock = sysclk >> AHBPrescTable[(cfgr & RCC_CFGR_HPRE) >> 4U];
}
