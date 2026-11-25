import { z } from 'zod'
import { OptionalString } from './rpc-param-primitives'

/** `orca bot slack intro [--off]`: says whether a bot's Slack channel intro is on, or turns it off.
 *  Nothing here can turn it on: only the owner's Orca does, through bots.update. */
export const BotSlackChannelHelloSet = z.object({
  /** Absent: the bot whose chat ran the command. */
  botId: OptionalString,
  callerSessionId: OptionalString,
  /** The token Orca handed the bot's run, which names its bot where a session id can be renamed. */
  botToken: OptionalString,
  /** Absent: only say whether it is on. */
  off: z.literal(true).optional()
})

export type BotSlackChannelHelloSetParams = z.infer<typeof BotSlackChannelHelloSet>
