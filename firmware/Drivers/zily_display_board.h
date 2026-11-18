#ifndef ZILY_DISPLAY_BOARD_H
#define ZILY_DISPLAY_BOARD_H

/* Confirmed board wiring: I2C1 remapped to PB8 (SCL) and PB9 (SDA). */
#define ZILY_DISPLAY_I2C             I2C1
#define ZILY_DISPLAY_I2C_CLOCK       RCC_APB1ENR_I2C1EN
#define ZILY_DISPLAY_I2C_REMAP       AFIO_MAPR_I2C1_REMAP
#define ZILY_DISPLAY_GPIO            GPIOB
#define ZILY_DISPLAY_GPIO_CLOCK      RCC_APB2ENR_IOPBEN
#define ZILY_DISPLAY_GPIO_CONFIG     CRH
#define ZILY_DISPLAY_SCL_PIN         8U
#define ZILY_DISPLAY_SDA_PIN         9U

/* Provisional panel profile: SSD1306, 128x64, internal charge pump. */
#define ZILY_DISPLAY_ADDRESS         0x3CU
#define ZILY_DISPLAY_WIDTH           128U
#define ZILY_DISPLAY_HEIGHT          64U

#endif
