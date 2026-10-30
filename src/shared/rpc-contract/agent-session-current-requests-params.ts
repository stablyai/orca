import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'

export const CurrentRequestsParams = z
  .object({
    sessionId: SessionId,
    version: z.string().uuid(),
    cursor: z.number().int().nonnegative().optional()
  })
  .strict()

export const CancelCurrentQuestionsParams = z
  .object({
    sessionId: SessionId,
    ids: z.array(z.string().min(1)).min(1)
  })
  .strict()
