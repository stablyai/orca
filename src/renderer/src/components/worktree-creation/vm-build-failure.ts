import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import type { PendingWorktreeCreation } from '@/lib/workspace/creation/pending-worktree-creation'
import {
  classifyEntitlementDenial,
  type OrcaEntitlementDenialKind
} from '../../../../shared/orca-billing'

/** Account and service problems a plain-language card can name, each with one way forward. */
export type VmBuildAccountFailureKind =
  | 'plan'
  | 'hoursUsed'
  | 'spendCap'
  | 'payment'
  | 'concurrency'
  | 'memberConcurrency'
  | 'githubNotConnected'
  /** Refused before the control plane was asked: the sandbox could not clone this repository. */
  | 'noGithubRemote'
  | 'signIn'
  | 'unavailable'
  | 'network'
  | 'snapshotMissing'

export type VmBuildFailure =
  | {
      kind: 'checks'
      problems: readonly EnvironmentDoctorCheck[]
      /** Orca Cloud: when the unused sandbox sleeps, and what became of it after. */
      sleepsAt?: number
      sandbox?: 'sleeping' | 'asleep' | 'deleted'
    }
  | { kind: VmBuildAccountFailureKind }
  /** The VM did not come up; the raw error is shown only for user-authored recipes. */
  | { kind: 'provision'; error: string }
  /** The VM came up, but creating the workspace on it failed. */
  | { kind: 'create'; error: string }
  /** Orca Cloud: the sandbox came up but cloning the repo failed; the sandbox was deleted. */
  | { kind: 'cloneFailed'; reason: string }

const ERROR_CODE_KINDS: Partial<Record<string, VmBuildAccountFailureKind>> = {
  cloudPlanRequired: 'plan',
  cloudConcurrencyLimit: 'concurrency',
  cloudSignInRequired: 'signIn',
  cloudUnavailable: 'unavailable',
  cloudGithubNotConnected: 'githubNotConnected',
  cloudNoGithubRemote: 'noGithubRemote'
}

// The hosted provider logs the control plane's deny reason as `Orca Cloud: <reason>`.
const DENY_REASON = /^Orca Cloud: ([a-z_]+)$/m
const DENIAL_FAILURE_KINDS: Partial<Record<OrcaEntitlementDenialKind, VmBuildAccountFailureKind>> =
  {
    hours: 'hoursUsed',
    spendCap: 'spendCap',
    payment: 'payment',
    teamLimit: 'concurrency',
    memberLimit: 'memberConcurrency'
  }

const SNAPSHOT_MISSING = /\bsnapshot\b[^\n]*\bnot found\b/i
const NETWORK_FAILURE =
  /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|network (error|unreachable))\b/i

/** Names why a VM build stopped, preferring the host's error code over text matching. */
export function classifyVmBuildFailure(args: {
  entry: Pick<
    PendingWorktreeCreation,
    'phase' | 'errorCode' | 'provisioningLog' | 'environmentCheck'
  >
  error: string | null
  cloud: boolean
}): VmBuildFailure | null {
  const { entry, error, cloud } = args
  const check = entry.environmentCheck
  if (check?.status === 'failed') {
    return {
      kind: 'checks',
      problems: (check.checks ?? []).filter((c) => c.status !== 'pass'),
      ...(check.sleepsAt !== undefined ? { sleepsAt: check.sleepsAt } : {}),
      ...(check.sandbox ? { sandbox: check.sandbox } : {})
    }
  }
  if (error === null) {
    return null
  }
  if (entry.errorCode === 'cloudCloneFailed') {
    return {
      kind: 'cloneFailed',
      reason: DENY_REASON.exec(entry.provisioningLog ?? '')?.[1] ?? 'clone_failed'
    }
  }
  const coded = entry.errorCode ? ERROR_CODE_KINDS[entry.errorCode] : undefined
  if (coded === 'plan' || coded === 'concurrency') {
    const reason = DENY_REASON.exec(entry.provisioningLog ?? '')?.[1]
    return {
      kind:
        (reason === undefined
          ? undefined
          : DENIAL_FAILURE_KINDS[classifyEntitlementDenial(reason)]) ?? coded
    }
  }
  if (coded) {
    return { kind: coded }
  }
  if (entry.phase === 'fetching' || entry.phase === 'creating') {
    return { kind: 'create', error }
  }
  if (cloud) {
    const evidence = `${error}\n${entry.provisioningLog ?? ''}`
    if (SNAPSHOT_MISSING.test(evidence)) {
      return { kind: 'snapshotMissing' }
    }
    if (NETWORK_FAILURE.test(error)) {
      return { kind: 'network' }
    }
  }
  return { kind: 'provision', error }
}

const ACCOUNT_GATES: ReadonlySet<VmBuildFailure['kind']> = new Set([
  'plan',
  'hoursUsed',
  'spendCap',
  'payment',
  'signIn',
  'concurrency',
  'memberConcurrency',
  'githubNotConnected',
  'noGithubRemote'
])

// Nothing started, so no step failed: steps stay pending instead of showing a red failure.
const NOTHING_STARTED: ReadonlySet<VmBuildFailure['kind']> = new Set([
  ...ACCOUNT_GATES,
  'unavailable',
  'network',
  // Refused while picking the saved environment, before any sandbox existed.
  'snapshotMissing'
])

export function nothingStarted(failure: VmBuildFailure | null): boolean {
  return failure !== null && NOTHING_STARTED.has(failure.kind)
}

/** Billing refusals an owner or admin fixes in Plan & billing. */
export function isBillingFailure(failure: VmBuildFailure | null): boolean {
  return (
    failure !== null &&
    (failure.kind === 'plan' ||
      failure.kind === 'hoursUsed' ||
      failure.kind === 'spendCap' ||
      failure.kind === 'payment')
  )
}

/** JA-21: the billing refusals the creating sheet shows as a blocker card, by kind. */
export function billingBlockKind(
  failure: VmBuildFailure | null
): 'plan' | 'hoursUsed' | 'spendCap' | 'payment' | null {
  const kind = failure?.kind
  return kind === 'plan' || kind === 'hoursUsed' || kind === 'spendCap' || kind === 'payment'
    ? kind
    : null
}

/**
 * The raw error a user-authored recipe printed, for the card's Details disclosure. Orca Cloud never
 * shows it. A recipe's terse exit message gets the build log's first error line after it.
 */
export function localRawError(
  failure: VmBuildFailure | null,
  firstErrorLine: string | null
): string | null {
  if (failure?.kind !== 'provision' && failure?.kind !== 'create') {
    return null
  }
  const error = failure.error.trim()
  const extra =
    failure.kind === 'provision' && firstErrorLine && !error.includes(firstErrorLine)
      ? firstErrorLine
      : null
  const text = [error, extra].filter(Boolean).join('\n\n')
  return text === '' ? null : text
}

/** Refused before anything started: an account limit, not a broken build. */
export function isAccountGate(failure: VmBuildFailure | null): boolean {
  return failure !== null && ACCOUNT_GATES.has(failure.kind)
}
