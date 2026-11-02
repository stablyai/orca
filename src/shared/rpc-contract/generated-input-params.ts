import { z } from 'zod'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../generated-agent-input-readiness'

// A remote caller names its terminal handle; the same-version local renderer names its PTY.
export const TerminalSendGeneratedInputParams = z
  .object({
    terminal: z.string().min(1).optional(),
    ptyId: z.string().min(1).optional(),
    text: z.string(),
    submit: z.boolean(),
    // A caller with no known agent sends null.
    agent: z.string().min(1).nullable().optional(),
    intent: z.enum(['startup', 'running']).optional(),
    timeoutMs: z.number().int().min(0).max(GENERATED_AGENT_INPUT_TIMEOUT_MS).optional(),
    inputKind: z.enum(['launch', 'driving']).optional(),
    part: z
      .object({
        id: z.string().min(1).max(128),
        index: z.number().int().min(0).max(4096),
        final: z.boolean()
      })
      .optional()
  })
  .refine((params) => (params.terminal === undefined) !== (params.ptyId === undefined), {
    message: 'Name exactly one of terminal or ptyId'
  })

export const DismissGeneratedInputNoticeParams = z.object({ id: z.string().min(1) })

export const GeneratedInputNoticesPageParams = z.object({
  cursor: z.number().int().min(0).optional(),
  offset: z.number().int().min(0).optional()
})

export const GeneratedInputNoticesUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1)
})
