import * as z from 'zod'
import { Identifier, SessionId } from './structured-agent-session-identifiers'

/** The chat row of one action the agent's automatic review denied. */
export const AutoReviewApprovalParams = z
  .object({
    sessionId: SessionId,
    itemId: Identifier('Invalid item id', 4096)
  })
  .strict()
