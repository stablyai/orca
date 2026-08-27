/**
 * Decides which stalled agent panes to recover and when. Pure and host-agnostic:
 * the same plan is correct for a local pane, an SSH worktree and a remote runtime.
 *
 * The hard constraint: a genuinely broken login keeps printing the same failure,
 * so every attempt is fenced by a settle window, backoff and an attempt cap.
 */

import type { AgentStallCause } from './agent-stall-signature'
import type { AgentStatusState } from './agent-status-types'

export type AgentStallObservation = {
  paneKey: string
  cause: AgentStallCause
  signature: string
  observedAt: number
}

/** What recovery has already been tried for a pane, per cause. */
export type AgentStallRecoveryLedgerEntry = {
  cause: AgentStallCause
  attempts: number
  lastAttemptAt: number
}

export type AgentStallRecoveryPaneFacts = {
  worktreeId: string
  /** Freshest explicit hook status, or null when Orca holds none. */
  status: AgentStatusState | null
  /** The pane resolves to a tab + leaf Orca can address on its owner host. */
  addressable: boolean
  /** When this pane's provider window reopens, from Orca's rate-limit subsystem.
   *  Null when unknown — a 'rate-limit' pane then waits for the user, because
   *  guessing early spends the first turn back on the same refusal. */
  rateLimitResetAt?: number | null
}

export type AgentStallRecoveryStep = {
  paneKey: string
  worktreeId: string
  cause: AgentStallCause
  /** 1-based number of the attempt this step records. */
  attempt: number
}

export type AgentStallRecoverySkipReason =
  | 'unknown-pane'
  | 'not-addressable'
  | 'expired'
  | 'agent-working'
  | 'settling'
  | 'backoff'
  | 'attempts-exhausted'
  | 'rate-limit-window'

export type AgentStallRecoverySkip = {
  paneKey: string
  reason: AgentStallRecoverySkipReason
}

export type AgentStallRecoveryPlan = {
  steps: AgentStallRecoveryStep[]
  skipped: AgentStallRecoverySkip[]
}

type CausePolicy = {
  /** Grace period before the first attempt. */
  settleMs: number
  retryBaseMs: number
  retryMaxMs: number
  maxAttempts: number
}

/** Why the causes differ: a network blip self-heals (the CLIs retry it
 *  internally, so nudging early double-submits the turn), an expired token needs
 *  a human — auth goes in fast, then waits much longer between attempts. */
const CAUSE_POLICIES: Record<AgentStallCause, CausePolicy> = {
  auth: { settleMs: 5_000, retryBaseMs: 120_000, retryMaxMs: 900_000, maxAttempts: 6 },
  network: { settleMs: 15_000, retryBaseMs: 30_000, retryMaxMs: 480_000, maxAttempts: 5 },
  // Why so few attempts: the window is a clock, not a flake — once it reopens
  // the first nudge works, and before it reopens no number of nudges can.
  'rate-limit': { settleMs: 5_000, retryBaseMs: 300_000, retryMaxMs: 1_800_000, maxAttempts: 3 }
}

/** A limit that has not reset yet: nudging now spends the turn on the same
 *  refusal, which is exactly what the user sees when they type `continue`. */
export function isAgentStallRateLimitWindowOpen(
  facts: Pick<AgentStallRecoveryPaneFacts, 'rateLimitResetAt'>,
  now: number
): boolean {
  const resetAt = facts.rateLimitResetAt
  return typeof resetAt === 'number' && now >= resetAt
}

/** Beyond this an observation describes a stall nobody is waiting on any more. */
export const AGENT_STALL_OBSERVATION_TTL_MS = 12 * 60 * 60 * 1000

/** A failure seen this long after the last attempt is a NEW episode with a fresh
 *  budget, so an exhausted pane degrades to a slow poll instead of being
 *  abandoned for the renderer's lifetime. Wider than the longest backoff. */
export const AGENT_STALL_EPISODE_RESET_MS = 30 * 60 * 1000

/** Recovery types a prompt into the pane and the pane echoes it back as output;
 *  within this window that echo (or the agent quoting the failure in its own
 *  prose) is not a new stall. Sized under the CLIs' retry ladders, so a genuine
 *  re-failure cannot be swallowed. */
export const AGENT_STALL_ECHO_SUPPRESSION_MS = 8_000

/** True when `observedAt` is close enough to a recovery attempt on the same pane
 *  to be Orca's own paste (or the agent quoting it) rather than a new failure. */
export function isLikelyRecoveryEchoObservation(
  ledger: AgentStallRecoveryLedgerEntry | undefined,
  observedAt: number
): boolean {
  if (!ledger) {
    return false
  }
  const sinceAttempt = observedAt - ledger.lastAttemptAt
  return sinceAttempt >= 0 && sinceAttempt < AGENT_STALL_ECHO_SUPPRESSION_MS
}

/** Within an episode the same observation drives every attempt, so `observedAt`
 *  sits BEFORE `lastAttemptAt` and the difference is negative. */
function isSameAgentStallEpisode(
  ledger: AgentStallRecoveryLedgerEntry | undefined,
  cause: AgentStallCause,
  observedAt: number
): boolean {
  if (!ledger || ledger.cause !== cause) {
    return false
  }
  return observedAt - ledger.lastAttemptAt <= AGENT_STALL_EPISODE_RESET_MS
}

/** Attempts already spent on this episode; 0 starts a fresh budget. */
function countAgentStallAttemptsInEpisode(
  ledger: AgentStallRecoveryLedgerEntry | undefined,
  observation: Pick<AgentStallObservation, 'cause' | 'observedAt'>
): number {
  return isSameAgentStallEpisode(ledger, observation.cause, observation.observedAt)
    ? (ledger?.attempts ?? 0)
    : 0
}

/** The ledger entry to store once an attempt is made. */
export function nextAgentStallLedgerEntry(
  ledger: AgentStallRecoveryLedgerEntry | undefined,
  attempt: { cause: AgentStallCause; observedAt: number; attemptedAt: number }
): AgentStallRecoveryLedgerEntry {
  return {
    cause: attempt.cause,
    attempts: countAgentStallAttemptsInEpisode(ledger, attempt) + 1,
    lastAttemptAt: attempt.attemptedAt
  }
}

export function getAgentStallCausePolicy(cause: AgentStallCause): CausePolicy {
  return CAUSE_POLICIES[cause]
}

/** Delay owed before attempt number `attempts + 1`. */
export function getAgentStallRetryDelayMs(cause: AgentStallCause, attempts: number): number {
  const policy = CAUSE_POLICIES[cause]
  if (attempts <= 0) {
    return 0
  }
  const backoff = policy.retryBaseMs * 2 ** (attempts - 1)
  return Math.min(policy.retryMaxMs, backoff)
}

function resolveSkipReason(
  observation: AgentStallObservation,
  facts: AgentStallRecoveryPaneFacts | undefined,
  ledger: AgentStallRecoveryLedgerEntry | undefined,
  now: number,
  force: boolean
): AgentStallRecoverySkipReason | null {
  if (!facts) {
    return 'unknown-pane'
  }
  if (now - observation.observedAt > AGENT_STALL_OBSERVATION_TTL_MS) {
    return 'expired'
  }
  if (!facts.addressable) {
    return 'not-addressable'
  }
  // No output-recency test: no hook fires during a CLI's internal retry, so
  // recency cannot tell "still retrying" from "stalled", and nudging mid-retry
  // queues a duplicate prompt. Retry ladders are bounded; waiting costs a poll.
  if (facts.status === 'working') {
    return 'agent-working'
  }
  // Deliberately above the `force` escape: Resume cannot reopen a provider
  // window, so an explicit click must not spend the pane's turn on a refusal.
  if (observation.cause === 'rate-limit' && !isAgentStallRateLimitWindowOpen(facts, now)) {
    return 'rate-limit-window'
  }
  // Everything below is "wait longer", which an explicit Resume overrides; the
  // checks above describe panes recovery cannot act on at all.
  if (force) {
    return null
  }
  const policy = CAUSE_POLICIES[observation.cause]
  if (now - observation.observedAt < policy.settleMs) {
    return 'settling'
  }
  const attempts = countAgentStallAttemptsInEpisode(ledger, observation)
  if (attempts >= policy.maxAttempts) {
    return 'attempts-exhausted'
  }
  if (attempts > 0 && ledger) {
    const owed = getAgentStallRetryDelayMs(observation.cause, attempts)
    if (now - ledger.lastAttemptAt < owed) {
      return 'backoff'
    }
  }
  return null
}

/** Plans every stalled pane at once: one expired token stalls the whole
 *  workspace, and all of them need continuing, not one. */
export function planAgentStallRecovery({
  observations,
  paneFacts,
  ledger,
  now,
  force = false
}: {
  observations: readonly AgentStallObservation[]
  paneFacts: Readonly<Record<string, AgentStallRecoveryPaneFacts | undefined>>
  ledger: Readonly<Record<string, AgentStallRecoveryLedgerEntry | undefined>>
  now: number
  /** An explicit user request: skip the settle, backoff, and attempt-cap fences. */
  force?: boolean
}): AgentStallRecoveryPlan {
  const steps: AgentStallRecoveryStep[] = []
  const skipped: AgentStallRecoverySkip[] = []
  // Deterministic order so a fleet recovery replays identically in tests and
  // recovers the longest-stalled pane first.
  const ordered = [...observations].sort(
    (a, b) => a.observedAt - b.observedAt || a.paneKey.localeCompare(b.paneKey)
  )

  for (const observation of ordered) {
    const facts = paneFacts[observation.paneKey]
    const reason = resolveSkipReason(observation, facts, ledger[observation.paneKey], now, force)
    if (reason || !facts) {
      skipped.push({ paneKey: observation.paneKey, reason: reason ?? 'unknown-pane' })
      continue
    }
    steps.push({
      paneKey: observation.paneKey,
      worktreeId: facts.worktreeId,
      cause: observation.cause,
      attempt: countAgentStallAttemptsInEpisode(ledger[observation.paneKey], observation) + 1
    })
  }

  return { steps, skipped }
}
