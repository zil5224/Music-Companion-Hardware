#include "zily_app_state.h"

volatile uint8_t zilyAppPlaying;
volatile uint8_t zilyAppFavorited;
volatile uint32_t zilyAppNextCount;

uint8_t ZilyAppStateExecute(uint8_t type, const uint8_t *payload, uint16_t length)
{
    switch (type)
    {
        case ZILY_APP_CMD_PAUSE:
            if (length != 0U)
            {
                return ZILY_APP_STATUS_BAD_PAYLOAD;
            }
            zilyAppPlaying = 0U;
            return ZILY_APP_STATUS_OK;

        case ZILY_APP_CMD_RESUME:
            if (length != 0U)
            {
                return ZILY_APP_STATUS_BAD_PAYLOAD;
            }
            zilyAppPlaying = 1U;
            return ZILY_APP_STATUS_OK;

        case ZILY_APP_CMD_NEXT:
            if (length != 0U)
            {
                return ZILY_APP_STATUS_BAD_PAYLOAD;
            }
            ++zilyAppNextCount;
            return ZILY_APP_STATUS_OK;

        case ZILY_APP_CMD_FAVORITE:
            if ((length != 1U) || (payload[0] > 1U))
            {
                return ZILY_APP_STATUS_BAD_PAYLOAD;
            }
            zilyAppFavorited = payload[0];
            return ZILY_APP_STATUS_OK;

        default:
            return ZILY_APP_STATUS_UNSUPPORTED;
    }
}

uint8_t ZilyAppStateFlags(void)
{
    uint8_t flags = 0U;

    if (zilyAppPlaying != 0U)
    {
        flags |= ZILY_APP_STATE_PLAYING;
    }
    if (zilyAppFavorited != 0U)
    {
        flags |= ZILY_APP_STATE_FAVORITED;
    }

    return flags;
}
