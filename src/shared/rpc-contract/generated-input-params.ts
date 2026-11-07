import { z } from 'zod'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../generated-agent-input-readiness'

/** A terminal handle that only the named runtime may execute. A receiver predating this form
 *  requires a string here, so it refuses the request before running anything. */
export const QualifiedTerminalTarget = z.object({
  handle: z.string().min(1),
  expectedRuntimeId: z.string().min(1).max(256)
})

// A remote caller names its terminal handle (qualified by the runtime that must run it, for a
// host that enforces that); the same-version local renderer names its PTY.
export const TerminalSendGeneratedInputParams = z
  .object({
    terminal: z.union([z.string().min(1), QualifiedTerminalTarget]).optional(),
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
    // A paired desktop window's key, naming who the operation's recovery belongs to.
    window: z.string().min(1).max(128).optional(),
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

// A paired desktop window's own key under its authenticated pairing (local IPC proves its window).
const NoticeWindow = z.string().min(1).max(128).optional()
// The runtime a recovery mutation was meant for; any other runtime refuses it unapplied.
const AuthorityRuntimeId = z.string().min(1).max(256).optional()
// Local IPC only: the paired host that runs this window's request (the runtime and pairing once
// known), and this window's key there.
const NoticeOwner = z
  .object({
    environmentId: z.string().min(1).max(256),
    window: z.string().min(1).max(128),
    runtimeId: z.string().min(1).max(256).optional(),
    pairingRevision: z.number().optional()
  })
  .optional()

export const DismissGeneratedInputNoticeParams = z.object({
  id: z.string().min(1).max(128),
  window: NoticeWindow,
  authorityRuntimeId: AuthorityRuntimeId,
  owner: NoticeOwner
})

// Registers (or settles) one operation's notice; it never writes to a terminal.

export const RegisterGeneratedInputNoticeParams = z.object({
  id: z.string().min(1).max(128),
  window: NoticeWindow,
  // Drop this window's pending record: the request ended without a failure to keep.
  settle: z.boolean().optional(),
  text: z.string(),
  agent: z.string().min(1).nullable(),
  certainty: z.enum(['not-sent', 'unconfirmed']),
  submitted: z.boolean().optional(),
  pending: z.boolean().optional(),
  authorityRuntimeId: AuthorityRuntimeId,
  owner: NoticeOwner,
  // Local IPC only: with settle, the host copy this window saw; else, the target was gone unwritten.
  observed: NoticeOwner,
  targetGone: z.boolean().optional(),
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
  offset: z.number().int().min(0).optional(),
  window: z.string().min(1).max(128).optional()
})

// Older clients subscribe with no params and read shared notices only.
export const GeneratedInputNoticesSubscribeParams = z
  .object({ window: z.string().min(1).max(128).optional() })
  .nullish()

export const GeneratedInputNoticesUnsubscribeParams = z.object({
  subscriptionId: z.string().min(1)
})
