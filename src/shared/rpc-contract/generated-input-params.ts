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
    requireConsumer: z.boolean().optional(),
    retainNotice: z.boolean().optional(),
    // One id per user action, on every part and on any recovery registration of it.
    operationId: z.string().min(1).max(128).optional(),
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

// Registers (or settles) one operation's notice; it never writes to a terminal.
export const RegisterGeneratedInputNoticeParams = z.object({
  id: z.string().min(1).max(128),
  // Drop this window's pending record: the request ended without a failure to keep.
  settle: z.boolean().optional(),
  text: z.string(),
  agent: z.string().min(1).nullable(),
  certainty: z.enum(['not-sent', 'unconfirmed']),
  submitted: z.boolean().optional(),
  pending: z.boolean().optional(),
  owner: z.string().min(1).max(256).optional(),
  handle: z.string().optional(),
  worktreeId: z.string().optional(),
  ptyId: z.string().nullable().optional(),
  part: z
    .object({
      id: z.string().min(1).max(128),
      index: z.number().int().min(0).max(4096),
      final: z.boolean()
    })
    .optional()
})

export const GeneratedInputNoticesPageParams = z.object({
  cursor: z.number().int().min(0).optional(),
  offset: z.number().int().min(0).optional()
})

export const GeneratedInputNoticesUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1)
})
