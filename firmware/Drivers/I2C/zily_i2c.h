#ifndef ZILY_I2C_H
#define ZILY_I2C_H

#include <stddef.h>
#include <stdint.h>

typedef enum
{
    ZILY_I2C_OK = 0,
    ZILY_I2C_TIMEOUT,
    ZILY_I2C_NACK,
    ZILY_I2C_BUS_ERROR,
    ZILY_I2C_ARBITRATION_LOST,
    ZILY_I2C_INVALID_ARGUMENT,
    ZILY_I2C_INVALID_CLOCK
} ZilyI2cStatus;

/* Initialize the display bus for 100 kHz standard mode. Single caller, polling
 * only. Call from thread context or before the scheduler starts. */
ZilyI2cStatus ZILY_I2C_Init(void);

/* Write a prefix and payload in one transaction to an unshifted 7-bit address.
 * A zero-length payload sends only the prefix. Init must have succeeded. */
ZilyI2cStatus ZILY_I2C_Write(uint8_t address, uint8_t prefix,
                            const uint8_t *data, size_t length);

#endif
