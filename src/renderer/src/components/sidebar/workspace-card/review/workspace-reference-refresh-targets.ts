import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { getVisibleHostedReviewWorkspaces } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-targets'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review/hosted-review-cache-identity'
import type { VisibleHostedReviewRefreshTarget } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import { reviewRefreshIntervalMs } from '../../../../../../shared/review-refresh-policy'
import { withTimeout } from '../../../../../../shared/promise-timeout-fallback'
import { getWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
import {
  getWorkspaceReferenceRequest,
  getWorkspaceReferenceRuntimeVersion,
  matchWorkspaceReferenceReview
} from './workspace-reference-details'
import { canReadWorkspaceReferenceReview } from './workspace-reference-review-source'
import { readWorkspaceReferenceDetails } from './workspace-reference-detail-read'
import { getDetachedWorkspaceReviewRequest } from './workspace-detached-review-request'
import {
  selectIsSleepingWorktree,
  selectWorktreeIdsWithLiveAgent
} from '../../workspace-actions/sleep/use-worktree-sleep-state'

function workspaceReferenceWorkspaces(state: AppState, options?: { selectedOnly?: boolean }) {
  return [...getVisibleHostedReviewWorkspaces(state, options)].filter(({ worktree }) =>
    getWorkspaceAttachments(worktree).some((item) => item.type !== 'issue')
  )
}

export function createWorkspaceReferenceRefreshTargetsSelector(options?: {
  selectedOnly?: boolean
}) {
  let workspaces: ReturnType<typeof workspaceReferenceWorkspaces> = []
  let inputs: readonly unknown[] = []
  let sleeping = new Map<string, boolean>()
  let liveWorktreeIds: ReadonlySet<string> = new Set()
  let result: VisibleHostedReviewRefreshTarget[] = []
  return (state: AppState, reviewInputsChanged: boolean): VisibleHostedReviewRefreshTarget[] => {
    const reset = inputs.length === 0 || reviewInputsChanged
    if (reset) {
      workspaces = workspaceReferenceWorkspaces(state, options)
    }
    const next = [
      state.tabsByWorktree,
      state.ptyIdsByTabId,
      state.browserTabsByWorktree,
      state.unifiedTabsByWorktree,
      state.structuredChatSleptAtByPaneKey,
      state.agentStatusByPaneKey,
      state.agentStatusEpoch
    ]
    if (!reset && next.every((value, index) => value === inputs[index])) {
      return result
    }
    const topologyChanged =
      reset || next.slice(0, 5).some((value, index) => value !== inputs[index])
    inputs = next
    const nextLiveWorktreeIds =
      workspaces.length > 0 ? selectWorktreeIdsWithLiveAgent(state) : liveWorktreeIds
    let changed = reset
    if (topologyChanged) {
      const nextSleeping = new Map<string, boolean>()
      for (const { worktree } of workspaces) {
        if (nextSleeping.has(worktree.id)) {
          continue
        }
        const value = selectIsSleepingWorktree(state, worktree.id)
        changed ||= value !== sleeping.get(worktree.id)
        nextSleeping.set(worktree.id, value)
      }
      sleeping = nextSleeping
    } else if (nextLiveWorktreeIds !== liveWorktreeIds) {
      // Why: only tracked workspaces can change the result, and status updates replace the live
      // set without changing membership, so diff just those instead of walking both sets.
      for (const [id, previous] of sleeping) {
        if (liveWorktreeIds.has(id) === nextLiveWorktreeIds.has(id)) {
          continue
        }
        const value = selectIsSleepingWorktree(state, id)
        changed ||= value !== previous
        sleeping.set(id, value)
      }
    }
    liveWorktreeIds = nextLiveWorktreeIds
    if (changed) {
      result = referenceRefreshTargets(state, workspaces, sleeping)
    }
    return result
  }
}

function referenceRefreshTargets(
  state: AppState,
  workspaces: ReturnType<typeof workspaceReferenceWorkspaces>,
  sleeping: ReadonlyMap<string, boolean>
): VisibleHostedReviewRefreshTarget[] {
  const targets = new Map<string, VisibleHostedReviewRefreshTarget>()
  for (const { worktree, repo, candidate, selected } of workspaces) {
    if (sleeping.get(worktree.id)) {
      continue
    }
    const branchKey = getHostedReviewCacheKey(
      repo.path,
      candidate.branch,
      state.settings,
      repo.id,
      repo.connectionId,
      repo.executionHostId,
      true
    )
    const knownProvider =
      state.hostedReviewCache[branchKey]?.data?.provider ??
      (state.prCache[candidate.cacheKey]?.data ? 'github' : undefined)
    const primaryExactKey = getDetachedWorkspaceReviewRequest(worktree, repo)?.key
    const runtimeVersion = getWorkspaceReferenceRuntimeVersion(worktree, repo)
    for (const item of getWorkspaceAttachments(worktree)) {
      if (item.type === 'issue') {
        continue
      }
      const request = {
        ...getWorkspaceReferenceRequest(item, worktree, repo, runtimeVersion),
        knownProvider
      }
      if (!canReadWorkspaceReferenceReview(request, knownProvider)) {
        continue
      }
      const key = request.key
      // The primary detached review already has a visible refresh target.
      if (key === primaryExactKey) {
        continue
      }
      if (targets.get(key)?.selected) {
        continue
      }
      const entry = state.hostedReviewCache[key]
      const review = matchWorkspaceReferenceReview(item, entry?.data) ? entry?.data : null
      targets.set(key, {
        key,
        revision: key,
        selected,
        fetchedAt: entry?.fetchedAt ?? null,
        intervalMs: reviewRefreshIntervalMs({
          state: review?.state,
          checksStatus: review?.status,
          hasReview: review ? true : null,
          selected
        }),
        refresh: (_force, signal) =>
          withTimeout(
            readWorkspaceReferenceDetails(
              { ...request, admissionTier: selected ? 'interactive' : 'background' },
              signal
            ).then(
              (data) =>
                !signal?.aborted &&
                data !== null &&
                !useAppStore.getState().hostedReviewCache[key]?.stale
            ),
            30_000,
            false
          )
      })
    }
  }
  return [...targets.values()]
}
