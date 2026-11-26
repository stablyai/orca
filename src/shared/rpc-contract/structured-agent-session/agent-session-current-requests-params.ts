import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { SessionId } from './structured-agent-session-identifiers'

export const CurrentRequestsParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId,
      version: z.string().uuid(),
      cursor: z.number().int().nonnegative().optional()
    })
    .strict()
)
