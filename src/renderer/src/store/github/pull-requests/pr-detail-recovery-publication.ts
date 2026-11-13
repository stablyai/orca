import type { StateCreator } from 'zustand'
import { createNonSecureContextUuid } from '../../../../../shared/non-secure-context-uuid'
import { capturePRCheckContract } from '@/lib/source-control/checks/pr-check-observation-contract'
import type { AppState } from '../../types'
import type {
  PRDetailRecoveryIdentity,
  PRDetailRecoverySnapshot
} from '../../../../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'
import type { PRRefreshOutcome } from '../../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { PRInfo } from '../../../../../shared/github/pull-requests/pull-request-types'
import { nextLookupGeneration } from '../../slices/hosted-review/refresh/lookup-generation-sequence'
import { prLookupIntentRevision, prRequestGenerations } from '../requests/request-coordination'
import { captureLinkedReviewClearScope, type LinkedReviewClearScope } from './linked-review-clear'
import { applyPullRequestLookupOutcome } from './pull-request-lookup-settlement'
import type { PRDetailRecoveryContext, PRDetailRecoveryOwner } from './pr-detail-recovery-context'
import { capRecordByInsertionOrder } from '../cache/cache-policy'

type SetState = Parameters<StateCreator<AppState>>[0]
type GetState = Parameters<StateCreator<AppState>>[1]

/** The pre-read ownership a recovery holds: captured after predecessors settle, before the provider starts. */
export type PRDetailRecoveryGrant = {
  grantId: string
  prepareToken: string
  generation: number
  intentRevision: number
  requestStartedAt: number
  hostedEntry: AppState['hostedReviewCache'][string] | undefined
  clearScope: LinkedReviewClearScope | undefined
  checkContract: ReturnType<typeof capturePRCheckContract>
}

export function capturePRDetailRecoveryGrant(
  get: GetState,
  context: PRDetailRecoveryContext,
  owner: PRDetailRecoveryOwner,
  runtimeEnvironmentId: string | null,
  prepareToken: string
): PRDetailRecoveryGrant {
  const state = get()
  const generation = nextLookupGeneration()
  // Own the alias now so any later direct lookup revokes this grant before or after dispatch.
  prRequestGenerations.set(owner.cacheKey, generation)
  return {
    grantId: createNonSecureContextUuid(),
    prepareToken,
    generation,
    intentRevision: prLookupIntentRevision(owner.cacheKey),
    requestStartedAt: Date.now(),
    hostedEntry: state.hostedReviewCache[context.hostedReviewCacheKey],
    clearScope:
      context.linkedPRNumber != null
        ? captureLinkedReviewClearScope(state, context.worktreeId, owner.repo)
        : undefined,
    checkContract: capturePRCheckContract(
      get,
      runtimeEnvironmentId
        ? { kind: 'environment', environmentId: runtimeEnvironmentId }
        : { kind: 'local' }
    )
  }
}

export function releasePRDetailRecoveryGrant(
  owner: PRDetailRecoveryOwner,
  grant: PRDetailRecoveryGrant | null
): void {
  if (grant && prRequestGenerations.get(owner.cacheKey) === grant.generation) {
    prRequestGenerations.delete(owner.cacheKey)
  }
}

export function prDetailRecoveryGrantOwnsAlias(
  owner: PRDetailRecoveryOwner,
  grant: PRDetailRecoveryGrant
): boolean {
  return (
    prRequestGenerations.get(owner.cacheKey) === grant.generation &&
    prLookupIntentRevision(owner.cacheKey) === grant.intentRevision
  )
}

/** Publish a settled ticket through the ordinary guarded writer; ticket data is never a second writer. */
export function publishPRDetailRecoveryOutcome(args: {
  set: SetState
  get: GetState
  identity: PRDetailRecoveryIdentity
  owner: PRDetailRecoveryOwner
  grant: PRDetailRecoveryGrant
  snapshot: PRDetailRecoverySnapshot
  outcome: PRRefreshOutcome
  isRuntime: boolean
}): PRInfo | null | 'refused' {
  const { set, get, identity, owner, grant, snapshot, outcome, isRuntime } = args
  const sequence = snapshot.requestSequence
  if (
    snapshot.publicationGrantId !== grant.grantId ||
    sequence === undefined ||
    !prDetailRecoveryGrantOwnsAlias(owner, grant) ||
    // Native host sequences share the event channel; a newer event for this alias wins.
    (!isRuntime && (get().prRefreshSequences[owner.cacheKey] ?? 0) > sequence)
  ) {
    return 'refused'
  }
  if (!isRuntime) {
    set((s) => ({
      prRefreshSequences: capRecordByInsertionOrder({
        ...s.prRefreshSequences,
        [owner.cacheKey]: sequence
      })
    }))
  }
  return applyPullRequestLookupOutcome({
    set,
    get,
    outcome,
    transportFailed: false,
    cacheKey: owner.cacheKey,
    cached: get().prCache[owner.cacheKey],
    generation: grant.generation,
    options: { worktreeId: identity.worktreeId, reason: 'active' },
    isRuntime,
    repo: owner.repo,
    repoId: owner.repo.id,
    repoPath: owner.repo.path,
    branch: identity.branch,
    requestSettings: owner.requestSettings,
    executionHostId: owner.executionHostId,
    checkContract: grant.checkContract,
    clearScope: grant.clearScope,
    requestHeadOid: identity.currentHeadOid,
    linkedPRNumber: identity.linkedPRNumber,
    fallbackPRNumber: identity.linkedPRNumber == null ? identity.fallbackPRNumber : null,
    fallbackPRSource: identity.linkedPRNumber == null ? identity.fallbackPRSource : null,
    requestStartedAt: grant.requestStartedAt,
    requestStartedHostedReviewEntry: grant.hostedEntry
  })
}
