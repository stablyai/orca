// Sharing a bot with people by email, from its owner's Orca: Orca accounts and invites (Bot.shares).
import * as z from 'zod'
import { BOT_MAX_SHARES, BotShareEmailSchema, normalizeShareEmail } from '../bots/bot-team-shares'
import { requiredString } from './rpc-param-primitives'

const BotId = requiredString('Missing bot')

export const BotTeamSharesAdd = z.object({
  botId: BotId,
  emails: z
    .array(z.string().transform(normalizeShareEmail).pipe(BotShareEmailSchema))
    .min(1)
    .max(BOT_MAX_SHARES)
})

export const BotTeamSharesRemove = z.object({
  botId: BotId,
  shareId: requiredString('Missing share')
})
