import React from 'react'
import type { Bot, BotLinear } from '../../../../../shared/bot-types'
import { BotWhoCanAskList } from '../BotWhoCanAskList'
import { useLinearWhoCanAsk } from './use-linear-who-can-ask'

/** Once linked in a workspace, the owner picks who there may ask the bot. */
export function LinkedPeople({ bot, linear }: { bot: Bot; linear: BotLinear }): React.JSX.Element {
  return <BotWhoCanAskList bot={bot} service={useLinearWhoCanAsk(bot.hostId, linear, true)} />
}
