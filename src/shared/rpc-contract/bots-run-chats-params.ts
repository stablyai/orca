import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { OptionalString } from './rpc-param-primitives'

/** `orca bot run-chats`: the bot named, or the calling chat's. */
export const BotRunChats = lazyZodSchema(() =>
  z.object({
    botId: OptionalString,
    callerSessionId: OptionalString
  })
)
