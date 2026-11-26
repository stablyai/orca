import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { Identifier, SessionId } from './structured-agent-session-identifiers'

/** The chat row of one action the agent's automatic review denied. */
export const AutoReviewApprovalParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId,
      itemId: Identifier('Invalid item id', 4096)
    })
    .strict()
)
