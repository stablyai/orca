import { z } from 'zod'

/**
 * Local commands: an agent in an Orca Cloud workspace asks to run one command on the person's own
 * computer. orcad only relays: the desktop that created the workspace decides, runs and audits.
 * Every rule that protects the computer is enforced on the desktop, never trusted from the VM.
 */
export const LOCAL_COMMANDS_REQUEST_METHOD = 'localCommands.request'
export const LOCAL_COMMANDS_STATUS_METHOD = 'localCommands.status'
/** Desktop-only stream: an attached desktop is one that turned local commands on for this workspace. */
export const LOCAL_COMMANDS_ATTACH_METHOD = 'localCommands.attach'
export const LOCAL_COMMANDS_SETTLE_METHOD = 'localCommands.settle'

export const LOCAL_COMMAND_MAX_COMMAND_CHARS = 4000
/** More lines than a person reads in one prompt is refused rather than scrolled past. */
export const LOCAL_COMMAND_MAX_LINES = 20
export const LOCAL_COMMAND_MAX_CWD_CHARS = 1024
export const LOCAL_COMMAND_REASON_MAX = 200
export const LOCAL_COMMAND_DEFAULT_TIMEOUT_SEC = 120
export const LOCAL_COMMAND_MAX_TIMEOUT_SEC = 600
/** How long a request waits for a person; then it is reported as not answered, never as denied. */
export const LOCAL_COMMAND_APPROVAL_WINDOW_MS = 5 * 60_000
/** Per stream; output past it is dropped and the result says so. */
export const LOCAL_COMMAND_OUTPUT_CAP_BYTES = 128 * 1024
/** A started command must report back within its timeout plus this. */
export const LOCAL_COMMAND_RESULT_GRACE_MS = 30_000
export const LOCAL_COMMAND_MAX_PENDING = 3
export const LOCAL_COMMAND_MAX_PER_HOUR = 60

const RequestId = z.string().regex(/^lc_[A-Za-z0-9_-]{16,64}$/)

// Characters that can hide or reorder what a person reads: C0/C1 controls (tab and newline are
// shown as they are), bidi overrides and isolates, zero-width and invisible formatting, lookalike
// spaces, combining marks and separators.
const HIDDEN_CHARS =
  // oxlint-disable-next-line no-control-regex, no-misleading-character-class -- SAFETY: matching control and invisible characters is the point.
  /[\u0000-\u0008\u000B-\u001F\u007F-\u00A0\u00AD\u0300-\u036F\u061C\u115F\u1160\u1680\u180E\u1AB0-\u1AFF\u1DC0-\u1DFF\u2000-\u200F\u2028-\u202F\u205F-\u206F\u20D0-\u20FF\u2800\u3000\u3164\uFE00-\uFE0F\uFE20-\uFE2F\uFEFF\uFFA0\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]/

/** True when the text holds a character that could make the shown command differ from the run one. */
export function hasHiddenCharacters(text: string): boolean {
  return HIDDEN_CHARS.test(text)
}

/** Shown as a warning: lookalike letters can make a command read as something else. */
export function hasNonAsciiCharacters(text: string): boolean {
  // oxlint-disable-next-line no-control-regex -- SAFETY: the printable ASCII range plus tab and newline.
  return /[^\u0009\u000A -~]/.test(text)
}

// oxlint-disable-next-line no-control-regex -- SAFETY: matching control characters is the point.
const REASON_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g

/** The agent's reason is display-only text: flattened to one line with hidden characters removed. */
export function sanitizeLocalCommandReason(reason: string): string {
  let out = ''
  for (const char of reason) {
    out += HIDDEN_CHARS.test(char) ? ' ' : char
  }
  return out.replace(REASON_CONTROL_CHARS, ' ').replace(/ {2,}/g, ' ').trim()
}

/** Never rewritten: the person approves exactly these characters, so anything unsafe is refused. */
export const LocalCommandText = z
  .string()
  .min(1)
  .max(LOCAL_COMMAND_MAX_COMMAND_CHARS)
  .refine((value) => value.trim().length > 0, 'empty_command')
  .refine((value) => !hasHiddenCharacters(value), 'hidden_characters')
  .refine((value) => value.split('\n').length <= LOCAL_COMMAND_MAX_LINES, 'too_many_lines')

/** Absolute, or ~ for the person's home folder. A single line. */
export const LocalCommandCwd = z
  .string()
  .min(1)
  .max(LOCAL_COMMAND_MAX_CWD_CHARS)
  .refine((value) => !hasHiddenCharacters(value) && !/[\t\n]/.test(value), 'hidden_characters')
  .refine(
    (value) => value === '~' || value.startsWith('~/') || value.startsWith('/'),
    'cwd_not_absolute'
  )

export const LocalCommandRequestParamsSchema = z
  .object({
    command: LocalCommandText,
    cwd: LocalCommandCwd.optional(),
    timeoutSec: z.number().int().min(1).max(LOCAL_COMMAND_MAX_TIMEOUT_SEC).optional(),
    reason: z
      .string()
      .max(LOCAL_COMMAND_REASON_MAX * 4)
      .transform(sanitizeLocalCommandReason)
      .pipe(z.string().max(LOCAL_COMMAND_REASON_MAX))
      .optional(),
    /** A hint, kept only when this orcad knows the worktree. */
    worktreeId: z.string().min(1).max(512).optional()
  })
  .strict()
export type LocalCommandRequestParams = z.infer<typeof LocalCommandRequestParamsSchema>

export const LocalCommandIdParamsSchema = z.object({ requestId: RequestId }).strict()

export const LocalCommandAttachParamsSchema = z
  .object({ desktopVersion: z.string().max(64).optional() })
  .strict()

const OutputText = z.string().max(LOCAL_COMMAND_OUTPUT_CAP_BYTES * 2)

export const LocalCommandRunResultSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().max(32).nullable(),
    timedOut: z.boolean(),
    durationMs: z.number().int().min(0),
    stdout: OutputText,
    stderr: OutputText,
    truncated: z.boolean()
  })
  .strict()
export type LocalCommandRunResult = z.infer<typeof LocalCommandRunResultSchema>

/** Why a request ended without running. `denied` is a person's answer; the others are not. */
export const LocalCommandDeclineReasonSchema = z.enum([
  'denied',
  'approval_timed_out',
  'not_allowed'
])
export type LocalCommandDeclineReason = z.infer<typeof LocalCommandDeclineReasonSchema>

export const LocalCommandSettleParamsSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      requestId: RequestId,
      outcome: z.literal('declined'),
      reason: LocalCommandDeclineReasonSchema
    })
    .strict(),
  z.object({ requestId: RequestId, outcome: z.literal('started') }).strict(),
  z
    .object({
      requestId: RequestId,
      outcome: z.literal('finished'),
      result: LocalCommandRunResultSchema
    })
    .strict(),
  z
    .object({
      requestId: RequestId,
      outcome: z.literal('failed'),
      message: z.string().max(500)
    })
    .strict()
])
export type LocalCommandSettleParams = z.infer<typeof LocalCommandSettleParamsSchema>

export type LocalCommandStatus =
  | 'pending'
  | 'running'
  | 'finished'
  | 'declined'
  | 'failed'
  /** Nobody answered within the approval window. */
  | 'expired'
  /** Started, but the computer never reported back (closed, asleep, offline). */
  | 'lost'

export type LocalCommandRequestResult = { requestId: string; status: 'pending' }

export type LocalCommandStatusResult = {
  requestId: string
  status: LocalCommandStatus
  declineReason?: LocalCommandDeclineReason
  result?: LocalCommandRunResult
  message?: string
}

export type LocalCommandSettleResult = { accepted: boolean; status: LocalCommandStatus }

/** Sent to attached desktops when a request is made, and replayed on attach while it waits. */
export type LocalCommandRequestedEvent = {
  type: 'requested'
  requestId: string
  command: string
  /** As the agent wrote it; the desktop resolves and shows the real folder. Null: home folder. */
  cwd: string | null
  timeoutSec: number
  /** Untrusted agent text, shown quoted and muted. */
  reason: string | null
  /** From the calling terminal's agent session as orcad verified it; null when unknown. */
  agent: string | null
  /** Relative, so the desktop's own clock decides; orcad expires the request on its clock too. */
  expiresInMs: number
}

export type LocalCommandSettledEvent = {
  type: 'settled'
  requestId: string
  status: Exclude<LocalCommandStatus, 'pending'>
}

export type LocalCommandStreamEvent =
  | { type: 'ready' }
  | LocalCommandRequestedEvent
  | LocalCommandSettledEvent
  | { type: 'end' }

/** Error codes (RPC error message) the CLI maps to guidance. */
export const LOCAL_COMMAND_ERRORS = {
  /** No desktop with local commands turned on is connected to this workspace. */
  noDesktop: 'local_commands_no_desktop',
  tooManyPending: 'local_commands_too_many_pending',
  rateLimited: 'local_commands_rate_limited',
  notFound: 'local_command_not_found',
  forbidden: 'local_command_forbidden',
  /** Only a cloud workspace's orcad relays local commands. */
  unavailable: 'local_commands_unavailable'
} as const

/** MCP server name agents see in their tool list (mcp__orca-local__run_local_command). */
export const LOCAL_COMMAND_MCP_SERVER_NAME = 'orca-local'
export const LOCAL_COMMAND_MCP_TOOL_NAME = 'run_local_command'
