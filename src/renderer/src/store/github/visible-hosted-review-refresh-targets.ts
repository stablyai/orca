import type { AppState } from '../types'
import {
  getHostedReviewCacheKey,
  linkedReviewHintKey
} from '../slices/hosted-review-cache-identity'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { reviewRefreshIntervalMs } from '../../../../shared/review-refresh-policy'
import { buildPRRefreshCandidate, findWorktreeById } from './worktree-refresh'
import { getPRRefreshRuntimeRepoTarget } from './repository-routing'
import type { VisibleHostedReviewRefreshTarget } from './visible-hosted-review-refresh-scheduler'
import { shouldCoordinateVisibleGitHubReview } from './visible-hosted-review-refresh-ownership'

export function getVisibleHostedReviewRefreshTargets(
  state: AppState,
  getState: () => AppState,
  options?: { selectedOnly?: boolean }
): VisibleHostedReviewRefreshTarget[] {
  const targets = new Map<string, VisibleHostedReviewRefreshTarget>()
  const revisions = new Map<string, Map<string, string>>()
  for (const id of state.visibleReviewWorktreeIds) {
    if (options?.selectedOnly && id !== state.activeWorktreeId) {
      continue
    }
    const worktree = findWorktreeById(state, id)
    if (!worktree || worktree.isArchived || worktree.isBare || !worktree.branch) {
      continue
    }
    const candidate = buildPRRefreshCandidate(state, worktree)
    if (
      !candidate ||
      candidate.repoKind !== 'git' ||
      !candidate.branch ||
      candidate.branch === 'HEAD'
    ) {
      continue
    }
    if (candidate.connectionId && candidate.connectionState !== 'connected') {
      continue
    }
    const key = getHostedReviewCacheKey(
      candidate.repoPath,
      candidate.branch,
      state.settings,
      candidate.repoId,
      candidate.connectionId,
      candidate.executionHostId,
      true
    )
    const hostedEntry = state.hostedReviewCache[key]
    const prEntry = state.prCache[candidate.cacheKey]
    const hints = {
      linkedGitHubPR: worktree.linkedPR,
      linkedGitLabMR: worktree.linkedGitLabMR,
      linkedBitbucketPR: worktree.linkedBitbucketPR,
      linkedAzureDevOpsPR: worktree.linkedAzureDevOpsPR,
      linkedGiteaPR: worktree.linkedGiteaPR
    }
    const nonGitHub =
      hints.linkedGitLabMR != null ||
      hints.linkedBitbucketPR != null ||
      hints.linkedAzureDevOpsPR != null ||
      hints.linkedGiteaPR != null ||
      (hostedEntry?.data != null && hostedEntry.data.provider !== 'github')
    const knownGitHub = shouldCoordinateVisibleGitHubReview(state, worktree, candidate)
    const runtime = knownGitHub ? getPRRefreshRuntimeRepoTarget(state, candidate) : null
    if (knownGitHub && !runtime) {
      continue
    }
    const selected = id === state.activeWorktreeId
    const usePR =
      knownGitHub &&
      prEntry !== undefined &&
      prEntry.fetchedAt >= (hostedEntry?.fetchedAt ?? -Infinity)
    const review = usePR ? prEntry.data : hostedEntry?.data
    const fetchedAt = usePR ? prEntry.fetchedAt : (hostedEntry?.fetchedAt ?? null)
    const target: VisibleHostedReviewRefreshTarget = {
      key,
      revision: `${candidate.currentHeadOid ?? ''}|${linkedReviewHintKey(hints)}`,
      fetchedAt:
        usePR &&
        candidate.cachedHeadOid &&
        candidate.currentHeadOid &&
        candidate.cachedHeadOid !== candidate.currentHeadOid
          ? null
          : fetchedAt,
      selected,
      intervalMs: reviewRefreshIntervalMs({
        state: review?.state,
        checksStatus: usePR ? prEntry.data?.checksStatus : hostedEntry?.data?.status,
        hasReview: review ? true : fetchedAt !== null ? false : null,
        selected
      }),
      refresh: async (force = true) => {
        const before = getState()
        const beforeFetchedAt = knownGitHub
          ? before.prCache[candidate.cacheKey]?.fetchedAt
          : before.hostedReviewCache[key]?.fetchedAt
        await (runtime
          ? before.fetchPRForBranch(candidate.repoPath, candidate.branch, {
              force: true,
              reason: 'visible',
              repoId: candidate.repoId,
              worktreeId: id,
              linkedPRNumber: candidate.linkedPRNumber,
              fallbackPRNumber: candidate.fallbackPRNumber,
              fallbackPRSource: candidate.fallbackPRSource
            })
          : before.fetchHostedReviewForBranch(candidate.repoPath, candidate.branch, {
              ...hints,
              force,
              repoId: candidate.repoId,
              repoOwnerExecutionHostId: getRepoExecutionHostId(candidate),
              fallbackGitHubPR: nonGitHub ? null : candidate.fallbackPRNumber,
              currentHeadOid: candidate.currentHeadOid,
              active: selected,
              admissionTier: selected ? 'interactive' : 'background'
            }))
        const after = getState()
        const afterFetchedAt = knownGitHub
          ? after.prCache[candidate.cacheKey]?.fetchedAt
          : after.hostedReviewCache[key]?.fetchedAt
        return (
          afterFetchedAt !== undefined &&
          (beforeFetchedAt === undefined || afterFetchedAt > beforeFetchedAt)
        )
      }
    }
    const branchRevisions = revisions.get(key) ?? new Map<string, string>()
    branchRevisions.set(id, target.revision)
    revisions.set(key, branchRevisions)
    const previous = targets.get(key)
    if (!previous || (selected && !previous.selected)) {
      targets.set(key, target)
    }
  }
  for (const [key, target] of targets) {
    target.aliasRevisions = revisions.get(key)
    target.revision = [...(target.aliasRevisions?.values() ?? [])].sort().join(';')
  }
  return [...targets.values()]
}

export function visibleHostedReviewRefreshInputsChanged(
  state: AppState,
  previous: AppState
): boolean {
  return (
    state.visibleReviewWorktreeIds !== previous.visibleReviewWorktreeIds ||
    state.activeWorktreeId !== previous.activeWorktreeId ||
    state.worktreesByRepo !== previous.worktreesByRepo ||
    state.repos !== previous.repos ||
    state.settings !== previous.settings ||
    state.sshConnectionStates !== previous.sshConnectionStates ||
    state.prCache !== previous.prCache ||
    state.hostedReviewCache !== previous.hostedReviewCache
  )
}
