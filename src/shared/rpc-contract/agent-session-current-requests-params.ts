import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'

export const CurrentRequestsParams = z
  .object({
    sessionId: SessionId,
    version: z.string().uuid(),
    cursor: z.number().int().nonnegative().optional()
  })
  .strict()
