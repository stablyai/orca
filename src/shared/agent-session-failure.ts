// Write typed facts with legacy text/reason sentences that released clients print directly. Set provider detail only at composition; later strings cannot prove authorship.

import type { AgentSessionAccountKind } from './agent-session-availability'
import {
  readAgentSessionArgumentProblem,
  type AgentSessionArgumentProblem
} from './agent-session-argument-problem'
export type { AgentSessionArgumentProblem } from './agent-session-argument-problem'
import {
  readAgentSessionUsageLimit,
  type AgentSessionUsageLimit
} from './agent-session-usage-limit'

import {
  readAgentSessionRequestTimeout,
  type AgentSessionRequestTimeout
} from './agent-session-request-timeout'
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
  /** The agent's CLI is not installed where the chat runs: its spawn found no such file. */
  'cliMissing',
  'historyTooLarge',
  'managedAccountEnvOverride',
  'accountSwitchInProgress',
  'managedAccountUnsupported',
  'launchFolderMissing',
  'historyInOtherAccount',
  'claudeAccountFolderMissing',
  'claudeAccountSetupFailed',
  'agentCommandNotRunnable',
  'runtimeNotInstalled',
  'providerExited',
  'restartFailed',
  'providerRejected',
  'attachmentInvalid',
  'attachmentUnreadable',
  'emptyMessage',
  /** One of the agent's own commands that its chats do not run, sent as a whole message. */
  'commandUnavailable',
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
  /** A Stop Orca could not save: only a refusal says it. */
  'stopFailed',
  /** A background-task Stop the agent answered with the task still running. */
  'backgroundTaskNotStopped',
  'answerUnconfirmed',
  'hostFault',
  /** Orca stopped an agent whose start never finished. */
  'hostStopped',
  /** The provider is retrying a request its API refused; not a failure yet. */
  'providerRetrying',
  /** The account hit one of the agent's usage limits, which ended the turn until it resets. */
  'usageLimitReached',
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
  'stopFailed',
  'backgroundTaskNotStopped',
  'answerUnconfirmed',
  'providerRetrying',
  'usageLimitReached',
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

/** Bound stderr dumps to the lease exit-reason cap so diagnostics always fit the record. */
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
  account?: AgentSessionAccountKind
  /** Provider-authored only; absent whenever Orca wrote the words. */
  detail?: ProviderDiagnostic
  /** On `restartFailed` and `startFailed`: the refusal that kept the agent from starting. On
   *  `commandRefused`: the refusal that kept the command from running. */
  refusal?: AgentSessionRefusalReference
  /** On `attachmentInvalid`: which check the attachment failed. */
  attachment?: AgentSessionAttachmentProblem
  /** On `providerRetrying`: why the provider is retrying. */
  retry?: AgentSessionProviderRetry
  /** On `usageLimitReached`: which limit, and when it resets. */
  usageLimit?: AgentSessionUsageLimit
  /** A safe option name from Orca's saved Arguments parser, never an error message. */
  argumentProblem?: AgentSessionArgumentProblem
  /** Host-only proof the provider never received the message: Stop owes stopped history and a refused carrier owes history again. Absence means unknown; clients read kind. */
  neverReachedAgent?: true
  /** On `backgroundTaskNotStopped`: one named task, or every task the Stop reached. */
  backgroundStop?: AgentSessionBackgroundStop
  /** On `startFailed`: the provider request that got no answer before Orca's deadline. */
  requestTimeout?: AgentSessionRequestTimeout
}

export type AgentSessionBackgroundStop = 'task' | 'all'

/** Persisted kinds may be newer; place them only through readAgentSessionFailureFact or the rejection classifier. */
export type UnreadAgentSessionFailureFact = { kind: string }

/** A fact a rejected message may carry. */
export type SubmissionRejectionFact = AgentSessionFailureFact & { kind: SubmissionRejectionKind }

export function isSubmissionRejectionFact(
  fact: AgentSessionFailureFact
): fact is SubmissionRejectionFact {
  return isSubmissionRejectionKind(fact.kind)
}

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
    account?: AgentSessionAccountKind
    detail?: ProviderDiagnostic
    refusal?: AgentSessionRefusalReference
    attachment?: AgentSessionAttachmentProblem
    retry?: AgentSessionProviderRetry
    usageLimit?: AgentSessionUsageLimit
    argumentProblem?: AgentSessionArgumentProblem
    neverReachedAgent?: true
    backgroundStop?: AgentSessionBackgroundStop
    requestTimeout?: AgentSessionRequestTimeout
  } = {}
): AgentSessionFailureFact & { kind: TKind } {
  // Re-bounded here, so no writer can store more than the cap however it built the detail.
  const detail = extra.detail
    ? providerDiagnostic(extra.detail.text, extra.detail.audience)
    : undefined
  return {
    kind,
    ...(extra.account ? { account: extra.account } : {}),
    ...(detail ? { detail } : {}),
    ...(extra.refusal ? { refusal: extra.refusal } : {}),
    ...(extra.attachment ? { attachment: extra.attachment } : {}),
    ...(extra.retry ? { retry: extra.retry } : {}),
    ...(extra.usageLimit ? { usageLimit: extra.usageLimit } : {}),
    ...(extra.argumentProblem ? { argumentProblem: extra.argumentProblem } : {}),
    ...(extra.neverReachedAgent ? { neverReachedAgent: true as const } : {}),
    ...(extra.backgroundStop ? { backgroundStop: extra.backgroundStop } : {}),
    ...(extra.requestTimeout ? { requestTimeout: extra.requestTimeout } : {})
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

/** Return undefined for unplaceable/newer facts so readers use their no-fact fallback. */
export function readAgentSessionFailureFact(value: unknown): AgentSessionFailureFact | undefined {
  if (!isRecord(value) || !isAgentSessionFailureKind(value.kind)) {
    return undefined
  }
  const refusal = readAgentSessionRefusalReference(value.refusal)
  const attachment = readAttachmentProblem(value.attachment)
  const retry = readProviderRetry(value.retry)
  const usageLimit = readAgentSessionUsageLimit(value.usageLimit)
  const argumentProblem = readAgentSessionArgumentProblem(value.argumentProblem)
  const requestTimeout = readAgentSessionRequestTimeout(value.requestTimeout)
  return agentSessionFailureFact(value.kind, {
    ...(value.account === 'managed' || value.account === 'system'
      ? { account: value.account }
      : {}),
    ...(isProviderDiagnostic(value.detail) ? { detail: value.detail } : {}),
    ...(refusal ? { refusal } : {}),
    ...(attachment ? { attachment } : {}),
    ...(retry ? { retry } : {}),
    ...(usageLimit ? { usageLimit } : {}),
    ...(argumentProblem ? { argumentProblem } : {}),
    ...(value.neverReachedAgent === true ? { neverReachedAgent: true as const } : {}),
    ...(value.backgroundStop === 'task' || value.backgroundStop === 'all'
      ? { backgroundStop: value.backgroundStop }
      : {}),
    ...(requestTimeout ? { requestTimeout } : {})
  })
}

/** Reword only fully understood facts; dropped/newer details may change the advice, so otherwise keep the host sentence. */
export function readWholeAgentSessionFailureFact(
  value: unknown
): AgentSessionFailureFact | undefined {
  const fact = readAgentSessionFailureFact(value)
  return fact && structuralValuesEqualIgnoringUndefined(fact, value) ? fact : undefined
}

/** Read provider-authored diagnostics through cause chains retained by wrappers such as acquisition errors. */
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
