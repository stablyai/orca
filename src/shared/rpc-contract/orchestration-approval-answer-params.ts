import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

// One screenful; the reason reaches the worker's agent as text.
export const APPROVAL_REASON_MAX_CHARS = 4_000

export const ApprovalAnswerParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  prompt: requiredString('Missing --prompt'),
  decision: z.enum(['allow', 'deny']),
  reason: z.string().max(APPROVAL_REASON_MAX_CHARS).optional(),
  from: OptionalString
})
