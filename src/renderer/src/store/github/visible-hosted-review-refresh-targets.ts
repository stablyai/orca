import type { AppState } from '../types'
import {
  getHostedReviewCacheKey,
  linkedReviewHintKey
} from '../slices/hosted-review-cache-identity'
import {
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId
} from '../../../../shared/execution-host'
import { reviewRefreshIntervalMs } from '../../../../shared/review-refresh-policy'
import {
  buildPRRefreshCandidate,
  getWorktreeLookupIndex,
  findWorktreeById
} from './worktree-refresh'
import { findIndexedDetectedWorktrees } from '@/lib/worktree-runtime-owner-index'
import { findKnownWorktreeById } from '../slices/worktrees/listing/detected-worktree-meta'
import { findRepoForHost } from '../slices/repo-host-identity'
import { getGitHubRepoLookupIndex } from '../slices/github-repo-lookup-index'
import { getPRRefreshRuntimeRepoTarget } from './repository-routing'
import type { VisibleHostedReviewRefreshTarget } from './visible-hosted-review-refresh-scheduler'
import { shouldCoordinateVisibleGitHubReview } from './visible-hosted-review-refresh-ownership'

export function* getVisibleHostedReviewWorkspaces(
  state: AppState,
  options?: { selectedOnly?: boolean }
) {
  const visibleHosts =
    state.visibleWorkspaceHostIds ??
    (state.workspaceHostScope && state.workspaceHostScope !== 'all'
      ? [state.workspaceHostScope]
      : null)
  for (const id of state.visibleReviewWorktreeIds) {
    const owners = new Set(getWorktreeLookupIndex(state).byId.get(id)?.owners)
    for (const detected of findIndexedDetectedWorktrees(state.detectedWorktreesByRepo, id)) {
      const workspace = findKnownWorktreeById(state, id, detected.hostId ?? 'local')
      if (workspace) {
        owners.add(workspace)
      }
    }
    for (const worktree of owners) {
      if (worktree.isArchived || worktree.isBare) {
        continue
      }
      const repo = findRepoForHost(state.repos, worktree.repoId, {
        hostId: worktree.hostId,
        settings: state.settings
      })
      if (!repo) {
        continue
      }
      const candidate = buildPRRefreshCandidate(state, worktree, undefined, repo)
      if (
        !candidate ||
        candidate.repoKind !== 'git' ||
        (candidate.connectionId && candidate.connectionState !== 'connected')
      ) {
        continue
      }
      const hostId = getRepoExecutionHostId(repo)
      const activeHost = state.activeWorkspaceExecutionHostId
      const selected =
        id === state.activeWorktreeId &&
        (activeHost
          ? hostId === activeHost
          : owners.size === 1 || hostId === getSettingsFocusedExecutionHostId(state.settings))
      if (
        (options?.selectedOnly && !selected) ||
        (!selected && visibleHosts && !visibleHosts.includes(hostId))
      ) {
        continue
      }
      yield { worktree, repo, candidate, selected }
    }
  }
}

export function getVisibleHostedReviewRefreshTargets(
  state: AppState,
  getState: () => AppState,
  options?: { selectedOnly?: boolean }
): VisibleHostedReviewRefreshTarget[] {
  const targets = new Map<string, VisibleHostedReviewRefreshTarget>()
  const revisions = new Map<string, Map<string, string>>()
  for (const { worktree, repo, candidate, selected } of getVisibleHostedReviewWorkspaces(
    state,
    options
  )) {
    const id = worktree.id
    if (!candidate.branch || candidate.branch === 'HEAD') {
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
    // The legacy GitHub action still resolves bare IDs; never pass it another owner's candidate.
    if (
      getGitHubRepoLookupIndex(state.repos).findById(repo.id) !== repo ||
      findWorktreeById(state, worktree.id) !== worktree
    ) {
      continue
    }
    const knownGitHub = shouldCoordinateVisibleGitHubReview(state, worktree, candidate)
    const runtime = knownGitHub ? getPRRefreshRuntimeRepoTarget(state, candidate) : null
    if (knownGitHub && !runtime) {
      continue
    }
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
    state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId ||
    state.visibleWorkspaceHostIds !== previous.visibleWorkspaceHostIds ||
    state.workspaceHostScope !== previous.workspaceHostScope ||
    state.worktreesByRepo !== previous.worktreesByRepo ||
    state.detectedWorktreesByRepo !== previous.detectedWorktreesByRepo ||
    state.repos !== previous.repos ||
    state.settings !== previous.settings ||
    state.sshConnectionStates !== previous.sshConnectionStates ||
    state.prCache !== previous.prCache ||
    state.hostedReviewCache !== previous.hostedReviewCache ||
    state.tabsByWorktree !== previous.tabsByWorktree ||
    state.ptyIdsByTabId !== previous.ptyIdsByTabId ||
    state.browserTabsByWorktree !== previous.browserTabsByWorktree ||
    state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
    state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
    state.agentStatusEpoch !== previous.agentStatusEpoch
  )
}
