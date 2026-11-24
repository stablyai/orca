import * as z from 'zod'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'

/** `orca bot work list`: the work a bot started; from its chat when no bot is named. */
export const BotWorkList = z.object({
  botId: OptionalString,
  callerSessionId: OptionalString,
  all: OptionalBoolean
})

/** `orca bot work forget`: the owner said to drop this conversation's work and start fresh. */
export const BotWorkForget = z.object({
  callerSessionId: requiredString('Run this from the conversation whose work to forget.')
})

export type BotWorkListParams = z.infer<typeof BotWorkList>
