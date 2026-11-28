import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { OptionalString } from './rpc-param-primitives'

/** Every Google tool call: the bot run's token (a bot's Google may be off), the chat it runs from for
 *  attribution, and which account. */
export const GoogleCallParams = {
  botToken: OptionalString,
  callerSessionId: OptionalString,
  account: z.string().trim().toLowerCase().email().max(320).optional()
}

/** A Google id, ref or link, as a command takes it. */
export const GoogleRef = lazyZodSchema(() => z.string().trim().min(1).max(2_048))
