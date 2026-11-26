import * as z from 'zod'
import { commanderMemoryId } from '../commander/memory-contract'
import { recurringQuestionLimit } from '../commander/recurring-answer'
import { BotSchema } from '../bot-types'

export const CommanderChatRecentResult = z.object({ goal: z.string(), progress: z.string() })
export const CommanderChatOpenResult = z.object({ bot: BotSchema })

export const CommanderChatAskPreferenceParams = z
  .object({
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    projectId: z.string().min(1).max(256),
    question: z.string().min(1).max(recurringQuestionLimit),
    requestId: commanderMemoryId
  })
  .strict()
