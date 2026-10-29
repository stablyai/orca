import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'

export const ValidateFlowAttentionParams = z
  .object({
    sessionId: SessionId,
    alert: z
      .object({
        flowId: z.string().min(1).max(2048),
        reason: z.enum(['input-required', 'action-required', 'flow-complete']),
        alertId: z.string().min(1).max(8192)
      })
      .strict()
  })
  .strict()
