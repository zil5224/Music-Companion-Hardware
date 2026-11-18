#include "zily_i2c.h"

#include "stm32f10x.h"
#include "../zily_display_board.h"

#define I2C_STANDARD_HZ      100000U
/* Per event, in register reads. Independent of SysTick and the scheduler. */
#define I2C_POLL_LIMIT       10000U
#define I2C_SCL              (1UL << ZILY_DISPLAY_SCL_PIN)
#define I2C_SDA              (1UL << ZILY_DISPLAY_SDA_PIN)
#define I2C_LINES            (I2C_SCL | I2C_SDA)
#define I2C_GPIO_OUT_OD      0x6UL /* 2 MHz, general-purpose open drain */
#define I2C_GPIO_AF_OD       0xEUL /* 2 MHz, alternate-function open drain */

static void SetPinMode(uint32_t mode)
{
    const uint32_t sclShift = (ZILY_DISPLAY_SCL_PIN % 8U) * 4U;
    const uint32_t sdaShift = (ZILY_DISPLAY_SDA_PIN % 8U) * 4U;

    ZILY_DISPLAY_GPIO->ZILY_DISPLAY_GPIO_CONFIG =
        (ZILY_DISPLAY_GPIO->ZILY_DISPLAY_GPIO_CONFIG &
         ~((0xFUL << sclShift) | (0xFUL << sdaShift))) |
        (mode << sclShift) | (mode << sdaShift);
}

static void ResetPeripheral(void)
{
    const uint16_t freq = ZILY_DISPLAY_I2C->CR2;
    const uint16_t ccr = ZILY_DISPLAY_I2C->CCR;
    const uint16_t trise = ZILY_DISPLAY_I2C->TRISE;

    ZILY_DISPLAY_I2C->CR1 = I2C_CR1_SWRST;
    ZILY_DISPLAY_I2C->CR1 = 0U;
    ZILY_DISPLAY_I2C->CR2 = freq;
    ZILY_DISPLAY_I2C->CCR = ccr;
    ZILY_DISPLAY_I2C->TRISE = trise;
    /* OAR1 bit 14 must remain set, even for a master-only bus. */
    ZILY_DISPLAY_I2C->OAR1 = 1U << 14U;
    ZILY_DISPLAY_I2C->CR1 = I2C_CR1_PE;
}

static ZilyI2cStatus WaitForIdle(void)
{
    uint32_t polls;

    for (polls = 0U; polls < I2C_POLL_LIMIT; ++polls)
    {
        if (((ZILY_DISPLAY_I2C->SR2 & I2C_SR2_BUSY) == 0U) &&
            ((ZILY_DISPLAY_GPIO->IDR & I2C_LINES) == I2C_LINES))
        {
            return ZILY_I2C_OK;
        }
    }
    return ZILY_I2C_TIMEOUT;
}

static uint8_t WaitForLines(uint32_t mask, uint32_t state)
{
    uint32_t polls;

    for (polls = 0U; polls < I2C_POLL_LIMIT; ++polls)
    {
        if ((ZILY_DISPLAY_GPIO->IDR & mask) == state)
        {
            return 1U;
        }
    }
    return 0U;
}

static uint8_t SetLines(uint32_t high, uint32_t low)
{
    ZILY_DISPLAY_GPIO->BSRR = high | (low << 16U);
    return WaitForLines(high | low, high);
}

static ZilyI2cStatus RecoverFalseBusy(void)
{
    uint8_t recovered;

    /* ES096 section 2.8.7: toggle both filters once on an electrically idle
     * bus. A device holding a line low is reported as a timeout. */
    ZILY_DISPLAY_I2C->CR1 = 0U;
    ZILY_DISPLAY_GPIO->BSRR = I2C_LINES;
    SetPinMode(I2C_GPIO_OUT_OD);
    recovered = WaitForLines(I2C_LINES, I2C_LINES) &&
                SetLines(0U, I2C_SDA) && SetLines(0U, I2C_SCL) &&
                SetLines(I2C_SCL, 0U) && SetLines(I2C_SDA, 0U);
    ZILY_DISPLAY_GPIO->BSRR = I2C_LINES;
    SetPinMode(I2C_GPIO_AF_OD);
    ResetPeripheral();

    return (recovered != 0U) ? WaitForIdle() : ZILY_I2C_TIMEOUT;
}

ZilyI2cStatus ZILY_I2C_Init(void)
{
    const uint32_t ppre1 = (RCC->CFGR & RCC_CFGR_PPRE1) >> 8U;
    const uint32_t pclk1 = SystemCoreClock >> ((ppre1 < 4U) ? 0U : ppre1 - 3U);
    const uint32_t freqMhz = pclk1 / 1000000U;
    const uint32_t divider = 2U * I2C_STANDARD_HZ;
    ZilyI2cStatus status;

    if ((pclk1 < 2000000U) || (pclk1 > 36000000U))
    {
        return ZILY_I2C_INVALID_CLOCK;
    }

    RCC->APB2ENR |= RCC_APB2ENR_AFIOEN | ZILY_DISPLAY_GPIO_CLOCK;
    RCC->APB1ENR |= ZILY_DISPLAY_I2C_CLOCK;
    (void)RCC->APB2ENR;
    (void)RCC->APB1ENR;
    ZILY_DISPLAY_I2C->CR1 = 0U;
    /* Preserve other remaps. SWJ_CFG is write-only; RM0008 defines 111 as
     * no effect, so this write also preserves the existing debug mode. */
    AFIO->MAPR |= ZILY_DISPLAY_I2C_REMAP | AFIO_MAPR_SWJ_CFG;
    ZILY_DISPLAY_I2C->CR2 = (uint16_t)freqMhz;
    ZILY_DISPLAY_I2C->CCR = (uint16_t)((pclk1 + divider - 1U) / divider);
    ZILY_DISPLAY_I2C->TRISE = (uint16_t)(freqMhz + 1U);

    ZILY_DISPLAY_GPIO->BSRR = I2C_LINES;
    SetPinMode(I2C_GPIO_AF_OD);
    ResetPeripheral();
    status = WaitForIdle();
    if ((status == ZILY_I2C_TIMEOUT) &&
        ((ZILY_DISPLAY_GPIO->IDR & I2C_LINES) == I2C_LINES))
    {
        status = RecoverFalseBusy();
    }
    return status;
}

static ZilyI2cStatus WaitForFlag(uint16_t flag)
{
    uint32_t polls;

    for (polls = 0U; polls < I2C_POLL_LIMIT; ++polls)
    {
        const uint16_t sr1 = ZILY_DISPLAY_I2C->SR1;

        if ((sr1 & I2C_SR1_ARLO) != 0U)
        {
            return ZILY_I2C_ARBITRATION_LOST;
        }
        if ((sr1 & (I2C_SR1_BERR | I2C_SR1_OVR)) != 0U)
        {
            return ZILY_I2C_BUS_ERROR;
        }
        if ((sr1 & I2C_SR1_AF) != 0U)
        {
            return ZILY_I2C_NACK;
        }
        if ((sr1 & I2C_SR1_TIMEOUT) != 0U)
        {
            return ZILY_I2C_TIMEOUT;
        }
        if ((sr1 & flag) != 0U)
        {
            return ZILY_I2C_OK;
        }
    }
    return ZILY_I2C_TIMEOUT;
}

static ZilyI2cStatus Send(uint8_t address, uint8_t prefix,
                          const uint8_t *data, size_t length)
{
    ZilyI2cStatus status;
    size_t index;

    ZILY_DISPLAY_I2C->CR1 |= I2C_CR1_START;
    status = WaitForFlag(I2C_SR1_SB);
    if (status != ZILY_I2C_OK)
    {
        return status;
    }
    /* The SR1 read that saw SB followed by this DR write clears SB. */
    ZILY_DISPLAY_I2C->DR = (uint16_t)address << 1U;
    status = WaitForFlag(I2C_SR1_ADDR);
    if (status != ZILY_I2C_OK)
    {
        return status;
    }
    /* The successful SR1 read followed by SR2 clears ADDR (RM0008 EV6). */
    (void)ZILY_DISPLAY_I2C->SR2;
    ZILY_DISPLAY_I2C->DR = prefix;

    for (index = 0U; index < length; ++index)
    {
        status = WaitForFlag(I2C_SR1_TXE);
        if (status != ZILY_I2C_OK)
        {
            return status;
        }
        ZILY_DISPLAY_I2C->DR = data[index];
    }
    /* EV8_2: both DR and the shift register are empty before STOP. */
    return WaitForFlag(I2C_SR1_BTF);
}

ZilyI2cStatus ZILY_I2C_Write(uint8_t address, uint8_t prefix,
                            const uint8_t *data, size_t length)
{
    ZilyI2cStatus status;
    ZilyI2cStatus idle;

    if ((address > 0x7FU) || ((data == NULL) && (length != 0U)))
    {
        return ZILY_I2C_INVALID_ARGUMENT;
    }

    status = WaitForIdle();
    if (status != ZILY_I2C_OK)
    {
        return status;
    }
    status = Send(address, prefix, data, length);
    if (status == ZILY_I2C_OK)
    {
        ZILY_DISPLAY_I2C->CR1 |= I2C_CR1_STOP;
        status = WaitForIdle();
        if (status != ZILY_I2C_OK)
        {
            ResetPeripheral();
        }
        return status;
    }

    /* After a NACK generate STOP while still master, then clear AF. After
     * arbitration loss the other master owns the bus. */
    if ((status != ZILY_I2C_ARBITRATION_LOST) &&
        ((ZILY_DISPLAY_I2C->SR2 & I2C_SR2_MSL) != 0U))
    {
        ZILY_DISPLAY_I2C->CR1 |= I2C_CR1_STOP;
    }
    /* Error bits are write-zero-to-clear. The event bits ignore writes. */
    ZILY_DISPLAY_I2C->SR1 = 0U;
    idle = WaitForIdle();
    if ((idle != ZILY_I2C_OK) || (status == ZILY_I2C_TIMEOUT) ||
        (status == ZILY_I2C_BUS_ERROR))
    {
        /* ES096 section 2.8.4: reset after a failed START or bus error. */
        ResetPeripheral();
    }
    return status;
}
