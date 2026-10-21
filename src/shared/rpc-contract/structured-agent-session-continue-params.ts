// Split out of structured-agent-session-params.ts, which is at its line limit.

import { z } from 'zod'
import { SessionId } from './structured-agent-session-params'

/** Continue on the chat's latest turn, which an Orca stop cut off. The host re-checks that this
 *  turn is still that cut before sending anything, so a stale or second click sends nothing. */
export const ContinueInterruptedParams = z
  .object({ sessionId: SessionId, turnItemId: z.string().min(1).max(1024) })
  .strict()
