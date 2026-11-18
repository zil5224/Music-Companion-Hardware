#ifndef ZILY_APP_STATE_H
#define ZILY_APP_STATE_H

#include <stdint.h>

/* Application command types carried in the frame TYPE byte. */
#define ZILY_APP_CMD_PAUSE     0x10U
#define ZILY_APP_CMD_RESUME    0x11U
#define ZILY_APP_CMD_NEXT      0x12U
#define ZILY_APP_CMD_FAVORITE  0x13U

/* STATUS byte values carried by APP_ACK. */
#define ZILY_APP_STATUS_OK           0x00U
#define ZILY_APP_STATUS_UNSUPPORTED  0x01U
#define ZILY_APP_STATUS_BAD_PAYLOAD  0x02U
#define ZILY_APP_STATUS_BAD_STATE    0x03U
#define ZILY_APP_STATUS_BUSY         0x04U
#define ZILY_APP_STATUS_INTERNAL     0x05U

/* STATE bit field carried by APP_ACK. */
#define ZILY_APP_STATE_PLAYING   0x01U
#define ZILY_APP_STATE_FAVORITED 0x02U

/* Apply one application command and return a ZILY_APP_STATUS_* value.
 * The payload is only read for FAVORITE; each command validates its length. */
uint8_t ZilyAppStateExecute(uint8_t type, const uint8_t *payload, uint16_t length);

/* Current PLAYING/FAVORITED snapshot for APP_ACK. */
uint8_t ZilyAppStateFlags(void);

/* Watch variables. Only the UART service task writes them in V1. */
extern volatile uint8_t zilyAppPlaying;
extern volatile uint8_t zilyAppFavorited;
extern volatile uint32_t zilyAppNextCount;

#endif
