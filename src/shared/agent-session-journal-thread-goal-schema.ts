// The journal's thread-goal transition, validated as deeply as the rest of the render model.

import { z } from 'zod'
import { openDiscriminatedUnion } from './agent-session-journal-open-union'

const ThreadGoal = z.object({
  objective: z.string(),
  status: z.string().min(1),
  tokenBudget: z.number().finite().nullable(),
  tokensUsed: z.number().finite(),
  timeUsedSeconds: z.number().finite(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite()
})

/** Like blocks: an unknown `state` stays admissible, a known one with a broken payload does not. */
export const AgentJournalThreadGoalStateSchema = openDiscriminatedUnion(
  z.discriminatedUnion('state', [
    z.object({ state: z.literal('set'), goal: ThreadGoal }),
    z.object({ state: z.literal('cleared') })
  ])
)
