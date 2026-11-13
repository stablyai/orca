import type {
  PRDetailRecoveryIdentity,
  PRDetailRecoverySnapshot,
  PRDetailRecoveryTerminal
} from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { Repo } from '../../../../../shared/repo-types'
import type { AppState } from '../../types'
import { getRuntimeRepoTarget } from '../repositories/repository-routing'
import { getGitHubSourceTarget } from '../work-items/work-item-routing'
import type {
  PRDetailRecoveryContext,
  PRDetailRecoveryOwner,
  PRDetailRecoveryStatus
} from './pr-detail-recovery-context'
import {
  releasePRDetailRecoveryGrant,
  type PRDetailRecoveryGrant
} from './pr-detail-recovery-publication'
import type { PRDetailRecoveryTransport } from './pr-detail-recovery-transport'

/** One panel context's automatic recovery: at most one is current per store. */
export type PRDetailRecoverySubscription = {
  contextKey: string
  context: PRDetailRecoveryContext
  owner: PRDetailRecoveryOwner
  cancelled: boolean
  transport: PRDetailRecoveryTransport | null
  ticketId: string | null
  grant: PRDetailRecoveryGrant | null
  intentRevision: number
  /** Keeps this alias's intent value from moving under unrelated eviction while compared. */
  releaseIntentPin: () => void
  /** The host started the read; newer local intent then only revokes publication. */
  admitted: boolean
  /** Close without a grant: the owning store's own detach and status update. */
  yieldToNewerIntent: () => void
}

const LOCAL_WAIT_BUDGET_MS = 30_000

/** Await another request's settlement within the local budget; true when it settled either way. */
export function awaitWithBudget(promise: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), LOCAL_WAIT_BUDGET_MS)
    const settled = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    void promise.then(settled, settled)
  })
}

export function buildPRDetailRecoveryIdentity(
  sub: PRDetailRecoverySubscription,
  transport: PRDetailRecoveryTransport,
  runtimeRepo: Repo | null
): PRDetailRecoveryIdentity {
  const { context } = sub
  const unlinked = context.linkedPRNumber == null
  return {
    sourceEpoch: transport.sourceEpoch,
    repoId: runtimeRepo?.id ?? sub.owner.repo.id,
    repoPath: runtimeRepo?.path ?? sub.owner.repo.path,
    worktreeId: context.worktreeId,
    branch: context.branch,
    currentHeadOid: context.headOid,
    executionHostId: sub.owner.repo.executionHostId ?? null,
    provider: 'github',
    linkedPRNumber: context.linkedPRNumber,
    fallbackPRNumber: unlinked ? context.hintPRNumber : null,
    fallbackPRSource: unlinked ? 'hosted-review' : null,
    selectionRevision: context.selectionRevision
  }
}

/** Settling a ticket and accepting its PR are separate: a refused publication hands status back. */
export function terminalRecoveryStatus(
  terminal: PRDetailRecoveryTerminal,
  published: boolean,
  usable: () => boolean
): PRDetailRecoveryStatus {
  switch (terminal.kind) {
    case 'settled':
      // A revoked grant hands status to whoever owns the alias now, even for an error outcome.
      if (!published) {
        return { kind: 'closed' }
      }
      if (terminal.outcome.kind === 'upstream-error') {
        return { kind: 'failed', errorType: terminal.outcome.errorType }
      }
      return usable() ? { kind: 'resolved' } : { kind: 'unusable' }
    case 'timeout':
      return { kind: 'timeout' }
    case 'superseded':
    case 'cancelled':
      return { kind: 'closed' }
    case 'expired':
    case 'not-admitted':
      return { kind: 'failed' }
  }
}

const START_RESUME_DELAYS_MS = [1_000, 3_000]
// One start observation never outlasts the host's own bounded wait; an unanswered invoke is a lost reply.
const START_OBSERVATION_MS = 20_000

function observeStart(
  start: () => Promise<PRDetailRecoverySnapshot>
): Promise<PRDetailRecoverySnapshot | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), START_OBSERVATION_MS)
    const settle = (snapshot: PRDetailRecoverySnapshot | null): void => {
      clearTimeout(timer)
      resolve(snapshot)
    }
    start().then(settle, () => settle(null))
  })
}

/**
 * Sends a start, then resends the identical epoch after a lost or unanswered reply while the
 * context is still current. The host returns the ticket it already accepted, so a resend never
 * adds a read, and a reply that arrives after we stopped listening is ignored: its uncommitted
 * ticket has no committer and expires without provider work. At most three observations.
 */
export async function startWithResume(
  start: () => Promise<PRDetailRecoverySnapshot>,
  stillCurrent: () => boolean
): Promise<PRDetailRecoverySnapshot | null> {
  const first = await observeStart(start)
  if (first) {
    return first
  }
  for (const delayMs of START_RESUME_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    if (!stillCurrent()) {
      return null
    }
    const resumed = await observeStart(start)
    if (resumed) {
      return resumed
    }
  }
  return null
}

const MAX_RETAINED_EPOCHS = 32
const retained = new Map<string, PRDetailRecoveryStatus>()

/** Epochs closed in this exposure; rendering the same context again shows them instead of re-arming. */
export const retainedEpochs = {
  get: (contextKey: string) => retained.get(contextKey),
  set: (contextKey: string, status: PRDetailRecoveryStatus): void => {
    retained.delete(contextKey)
    retained.set(contextKey, status)
    for (const oldest of retained.keys()) {
      if (retained.size <= MAX_RETAINED_EPOCHS) {
        break
      }
      retained.delete(oldest)
    }
  },
  clear: (): void => retained.clear()
}

/** The paired runtime that owns this context's repo, or null for this app's own host. */
export function recoveryRuntimeTarget(
  state: AppState,
  sub: PRDetailRecoverySubscription
): ReturnType<typeof getRuntimeRepoTarget> {
  return getRuntimeRepoTarget(
    state,
    { repoId: sub.context.repoId, repoPath: sub.context.repoPath },
    getGitHubSourceTarget(state, sub.owner.repo)
  )
}

export function newPRDetailRecoverySubscription(
  contextKey: string,
  context: PRDetailRecoveryContext,
  owner: PRDetailRecoveryOwner,
  yieldToNewerIntent: () => void
): PRDetailRecoverySubscription {
  return {
    contextKey,
    context,
    owner,
    cancelled: false,
    transport: null,
    ticketId: null,
    grant: null,
    intentRevision: 0,
    releaseIntentPin: () => {},
    admitted: false,
    yieldToNewerIntent
  }
}

export function detachPRDetailRecoverySubscription(sub: PRDetailRecoverySubscription): void {
  sub.cancelled = true
  sub.transport?.dispose?.()
  sub.releaseIntentPin()
  releasePRDetailRecoveryGrant(sub.owner, sub.grant)
  if (sub.transport && sub.ticketId) {
    void sub.transport.cancel(sub.ticketId).catch(() => {})
  }
}
