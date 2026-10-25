import { z } from 'zod'
import { SessionId } from './structured-agent-session-params'

/** Recheck the latest Orca-interrupted turn before continuing; stale or repeated clicks send nothing. */
export const ContinueInterruptedParams = z
  .object({ sessionId: SessionId, turnItemId: z.string().min(1).max(1024) })
  .strict()
