import * as z from 'zod'
import { OptionalString } from './rpc-param-primitives'

/** `orca bot run-chats`: the bot named, or the calling chat's. */
export const BotRunChats = z.object({
  botId: OptionalString,
  callerSessionId: OptionalString
})
