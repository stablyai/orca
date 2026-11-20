// Bringing a bot over from another app: what Orca finds on the bot's host, and the bot's plan and summary cards.
import * as z from 'zod'
import { BotImportDoneInputSchema, BotImportPlanInputSchema } from '../bots/bot-import-cards'
import { requiredString } from './rpc-param-primitives'

/** The bots other apps keep on this host. */
export const BotImportSources = z.object({})

export const BotImportPlanCard = z.object({
  callerSessionId: requiredString("Run this from a bot's chat."),
  plan: BotImportPlanInputSchema
})

export const BotImportDoneCard = z.object({
  callerSessionId: requiredString("Run this from a bot's chat."),
  done: BotImportDoneInputSchema
})
