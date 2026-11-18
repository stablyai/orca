import * as z from 'zod'
import { OptionalString } from './rpc-param-primitives'

/** Every Google tool call: the chat it runs from (a bot's Google may be off) and which account. */
export const GoogleCallParams = {
  callerSessionId: OptionalString,
  account: z.string().trim().toLowerCase().email().max(320).optional()
}

/** A Google id, ref or link, as a command takes it. */
export const GoogleRef = z.string().trim().min(1).max(2_048)
