// Bringing a bot over from another app: what Orca finds on the bot's host, and the bot's plan and summary cards.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { BotImportDoneInputSchema, BotImportPlanInputSchema } from '../bots/bot-import-cards'
import { requiredString } from './rpc-param-primitives'

/** The bots other apps keep on this host. */
export const BotImportSources = lazyZodSchema(() => z.object({}))

export const BotImportPlanCard = lazyZodSchema(() =>
  z.object({
    callerSessionId: requiredString("Run this from a bot's chat."),
    plan: BotImportPlanInputSchema
  })
)

export const BotImportDoneCard = lazyZodSchema(() =>
  z.object({
    callerSessionId: requiredString("Run this from a bot's chat."),
    done: BotImportDoneInputSchema
  })
)
