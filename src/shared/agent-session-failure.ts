// What went wrong in a chat, typed where the host decides it, beside the sentence a person reads.
//
// The host writes both at once: `text`/`reason` stays a complete sentence because released clients
// print it as it is, and this fact is what newer clients choose their copy and action from. A
// provider's own words ride separately as `detail`, set only where Orca composed them from a
// value the provider wrote — never recovered from a string afterwards, since by then nothing can
// tell a provider's sentence from Orca's.

import {
  readAgentSessionArgumentProblem,
  type AgentSessionArgumentProblem
} from './agent-session-argument-problem'
export type { AgentSessionArgumentProblem } from './agent-session-argument-problem'

import { structuralValuesEqualIgnoringUndefined } from './structural-value-equality'
import {
  readAgentSessionRefusalReference,
  type AgentSessionRefusalReference
} from './agent-session-wire-refusals'

/** One per situation with its own honest next step; a new one needs copy before it compiles. */
export const AGENT_SESSION_FAILURE_KINDS = [
  /** Only an observed exit: the provider stopped while starting. */
  'providerStartFailed',
  /** A start that did not land, with no one to blame: Orca's fault, a failed spawn, a close. */
  'startFailed',
  'notSignedIn',
  'historyTooLarge',
  'managedAccountEnvOverride',
  'accountSwitchInProgress',
  'managedAccountUnsupported',
  'launchFolderMissing',
  'historyInOtherAccount',
  'claudeAccountFolderMissing',
  'claudeAccountSetupFailed',
  'agentCommandNotRunnable',
  'providerExited',
  'restartFailed',
  'providerRejected',
  'attachmentInvalid',
  'attachmentUnreadable',
  'emptyMessage',
  'queueFull',
  'writeFailed',
  'cancelled',
  'chatClosed',
  'hostRestarted',
  'notDelivered',
  /** A conversation command the chat's state refused when its turn to run came. */
  'commandRefused',
  'compactionFailed',
  'compactionUnconfirmed',
  'cancelUnconfirmed',
  /** A Stop naming no turn reached the agent, which ended nothing while the chat read working. */
  'stopRefused',
  'answerUnconfirmed',
  'hostFault',
  /** Orca stopped an agent whose start never finished. */
  'hostStopped',
  /** The provider is retrying a request its API refused; not a failure yet. */
  'providerRetrying',
  /** A child a Stop could not prove gone: its exit is unverifiable. Kept for rows hosts wrote. */
  'previousExitUnverifiable',
  /** The agent could not reopen the chat's saved session, so a fresh one without its memory continues it. */
  'sessionNotRestored'
] as const
export type AgentSessionFailureKind = (typeof AGENT_SESSION_FAILURE_KINDS)[number]

export function isAgentSessionFailureKind(value: unknown): value is AgentSessionFailureKind {
  return typeof value === 'string' && AGENT_SESSION_FAILURE_KINDS.some((kind) => kind === value)
}

/** Kinds only a status row reports: none is ever why a message was not sent. */
const STATUS_ROW_ONLY_FAILURE_KINDS = [
  'compactionFailed',
  'compactionUnconfirmed',
  'cancelUnconfirmed',
  'stopRefused',
  'answerUnconfirmed',
  'providerRetrying',
  'previousExitUnverifiable',
  'sessionNotRestored'
] as const satisfies readonly AgentSessionFailureKind[]

/** Why a message was not sent. A new failure kind is one of these until listed above. */
export type SubmissionRejectionKind = Exclude<
  AgentSessionFailureKind,
  (typeof STATUS_ROW_ONLY_FAILURE_KINDS)[number]
>

export function isSubmissionRejectionKind(value: unknown): value is SubmissionRejectionKind {
  return (
    isAgentSessionFailureKind(value) &&
    !STATUS_ROW_ONLY_FAILURE_KINDS.some((statusOnly) => statusOnly === value)
  )
}

/** `person`: written by the provider for whoever reads the chat, shown inline. `log`: a stderr
 *  tail or exit status, shown only behind Details. */
export type ProviderDiagnosticAudience = 'person' | 'log'

export type ProviderDiagnostic = {
  text: string
  audience: ProviderDiagnosticAudience
}

/** Stderr can be a whole dump; the row keeps enough to act on. The same cap as the exit reason a
 *  lease record keeps, so a diagnostic never outgrows what the record may store. */
export const MAX_PROVIDER_DIAGNOSTIC_CHARS = 512

/** Which of Orca's checks an image failed. A new one needs a sentence before it compiles. */
export const AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS = [
  'empty',
  'tooLarge',
  'tooMany',
  'totalTooLarge',
  'unsupportedType',
  'notAFile',
  'noSource'
] as const
export type AgentSessionAttachmentProblemReason =
  (typeof AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS)[number]

export type AgentSessionAttachmentProblem = {
  reason: AgentSessionAttachmentProblemReason
  /** The limit it broke: bytes for `tooLarge` and `totalTooLarge`, a count for `tooMany`. */
  limit?: number
}

/** What the provider said it is retrying, in its own fields. */
export type AgentSessionProviderRetry = {
  /** The provider's error type, e.g. `rate_limit` or `overloaded`. */
  error?: string
  /** The HTTP status the request failed with. */
  status?: number
  /** The provider's own account of what failed, written for a person: the row's second line. */
  cause?: string
  /** Which retry this is, counted from 1. */
  attempt?: number
  /** The most retries the provider makes before it gives up. */
  maxRetries?: number
}

export type AgentSessionFailureFact = {
  kind: AgentSessionFailureKind
  /** Provider-authored only; absent whenever Orca wrote the words. */
  detail?: ProviderDiagnostic
  /** On `restartFailed` and `startFailed`: the refusal that kept the agent from starting. On
   *  `commandRefused`: the refusal that kept the command from running. */
  refusal?: AgentSessionRefusalReference
  /** On `attachmentInvalid`: which check the attachment failed. */
  attachment?: AgentSessionAttachmentProblem
  /** On `providerRetrying`: why the provider is retrying. */
  retry?: AgentSessionProviderRetry
  /** A safe option name from Orca's saved Arguments parser, never an error message. */
  argumentProblem?: AgentSessionArgumentProblem
}

/** A fact as a row stores it: its kind may be one a newer host added, so only
 *  `readAgentSessionFailureFact` or the rejection classifier may place it. */
export type UnreadAgentSessionFailureFact = { kind: string }

/** A fact a rejected message may carry. */
export type SubmissionRejectionFact = AgentSessionFailureFact & { kind: SubmissionRejectionKind }

export function isSubmissionRejectionFact(
  fact: AgentSessionFailureFact
): fact is SubmissionRejectionFact {
  return isSubmissionRejectionKind(fact.kind)
}

/** Null for empty text, so a writer never records a detail with nothing in it. */
export function providerDiagnostic(
  text: string,
  audience: ProviderDiagnosticAudience
): ProviderDiagnostic | undefined {
  const bounded = text.trim().slice(0, MAX_PROVIDER_DIAGNOSTIC_CHARS).trim()
  return bounded ? { text: bounded, audience } : undefined
}

export function agentSessionFailureFact<TKind extends AgentSessionFailureKind>(
  kind: TKind,
  extra: {
    detail?: ProviderDiagnostic
    refusal?: AgentSessionRefusalReference
    attachment?: AgentSessionAttachmentProblem
    retry?: AgentSessionProviderRetry
    argumentProblem?: AgentSessionArgumentProblem
  } = {}
): AgentSessionFailureFact & { kind: TKind } {
  // Re-bounded here, so no writer can store more than the cap however it built the detail.
  const detail = extra.detail
    ? providerDiagnostic(extra.detail.text, extra.detail.audience)
    : undefined
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(extra.refusal ? { refusal: extra.refusal } : {}),
    ...(extra.attachment ? { attachment: extra.attachment } : {}),
    ...(extra.retry ? { retry: extra.retry } : {}),
    ...(extra.argumentProblem ? { argumentProblem: extra.argumentProblem } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isProviderDiagnostic(value: unknown): value is ProviderDiagnostic {
  return (
    isRecord(value) &&
    typeof value.text === 'string' &&
    (value.audience === 'person' || value.audience === 'log')
  )
}

function readAttachmentProblem(value: unknown): AgentSessionAttachmentProblem | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const reason = AGENT_SESSION_ATTACHMENT_PROBLEM_REASONS.find((known) => known === value.reason)
  if (!reason) {
    return undefined
  }
  const limit = value.limit
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? { reason, limit }
    : { reason }
}

/** A retry as a reader meets it; undefined when it names no field. */
export function readProviderRetry(value: unknown): AgentSessionProviderRetry | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const error =
    typeof value.error === 'string' && value.error.trim() ? value.error.trim() : undefined
  const status = positiveInteger(value.status)
  const cause =
    typeof value.cause === 'string' ? providerDiagnostic(value.cause, 'person')?.text : undefined
  const attempt = positiveInteger(value.attempt)
  // A maximum bounds a retry; alone, or below the retry it bounds, it says nothing.
  const max = positiveInteger(value.maxRetries)
  const maxRetries = attempt && max && max >= attempt ? max : undefined
  return error || status || cause || attempt
    ? {
        ...(error ? { error } : {}),
        ...(status ? { status } : {}),
        ...(cause ? { cause } : {}),
        ...(attempt ? { attempt } : {}),
        ...(maxRetries ? { maxRetries } : {})
      }
    : undefined
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** A fact as a reader meets it. Undefined for anything this build cannot place, including a kind a
 *  newer host added, so the reader falls back to what it does for a row with no fact. */
export function readAgentSessionFailureFact(value: unknown): AgentSessionFailureFact | undefined {
  if (!isRecord(value) || !isAgentSessionFailureKind(value.kind)) {
    return undefined
  }
  const refusal = readAgentSessionRefusalReference(value.refusal)
  const attachment = readAttachmentProblem(value.attachment)
  const retry = readProviderRetry(value.retry)
  const argumentProblem = readAgentSessionArgumentProblem(value.argumentProblem)
  return agentSessionFailureFact(value.kind, {
    ...(isProviderDiagnostic(value.detail) ? { detail: value.detail } : {}),
    ...(refusal ? { refusal } : {}),
    ...(attachment ? { attachment } : {}),
    ...(retry ? { retry } : {}),
    ...(argumentProblem ? { argumentProblem } : {})
  })
}

/** The fact only when this build read all of it. Anything it dropped, such as a newer refusal code
 *  or reason, may change the advice, so a surface that would re-word the fact shows the host's
 *  sentence instead. */
export function readWholeAgentSessionFailureFact(
  value: unknown
): AgentSessionFailureFact | undefined {
  const fact = readAgentSessionFailureFact(value)
  return fact && structuralValuesEqualIgnoringUndefined(fact, value) ? fact : undefined
}

/** The provider-authored diagnostic an error carries, set only where it was composed. Follows the
 *  `cause` chain, since wrappers such as the acquisition errors keep the original as their cause. */
export function providerDiagnosticOf(error: unknown): ProviderDiagnostic | undefined {
  return providerDiagnosticWithin(error, 0)
}

// One depth bound across `cause` and aggregated errors, so an error that contains itself ends.
function providerDiagnosticWithin(error: unknown, start: number): ProviderDiagnostic | undefined {
  let current: unknown = error
  for (let depth = start; depth < 6 && current instanceof Error; depth += 1) {
    if ('providerDiagnostic' in current && isProviderDiagnostic(current.providerDiagnostic)) {
      return current.providerDiagnostic
    }
    if (current instanceof AggregateError) {
      for (const inner of current.errors) {
        const found = providerDiagnosticWithin(inner, depth + 1)
        if (found) {
          return found
        }
      }
    }
    current = current.cause
  }
  return undefined
}

/** Attaches the provider's words to the error Orca built around them. */
export function withProviderDiagnostic<TError extends Error>(
  error: TError,
  diagnostic: ProviderDiagnostic | undefined
): TError {
  return diagnostic ? Object.assign(error, { providerDiagnostic: diagnostic }) : error
}
