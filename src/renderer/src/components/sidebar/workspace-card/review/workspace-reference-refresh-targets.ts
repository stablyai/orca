import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { getVisibleHostedReviewWorkspaces } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-targets'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review/hosted-review-cache-identity'
import type { VisibleHostedReviewRefreshTarget } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import { reviewRefreshIntervalMs } from '../../../../../../shared/source-control/hosted-review/review-refresh-policy'
import { getPRRefreshOwnerRuntimeEnvironmentId } from '@/store/github/repositories/repository-routing'
import { hostPRAutoRefreshCadence } from '@/store/github/refresh/remote-host-pr-auto-refresh-cadence'
import { withTimeout } from '../../../../../../shared/concurrency/promise-timeout-fallback'
import { getReadonlyWorkspaceAttachments } from '../../../../../../shared/workspace-attachments/workspace-attachments'
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

type VisibleHostedReviewWorkspace =
  ReturnType<typeof getVisibleHostedReviewWorkspaces> extends Iterable<infer T> ? T : never

function workspaceReferenceWorkspaces(
  state: AppState,
  options?: { selectedOnly?: boolean }
): VisibleHostedReviewWorkspace[] {
  const matched: VisibleHostedReviewWorkspace[] = []
  for (const entry of getVisibleHostedReviewWorkspaces(state, options)) {
    const attachments = getReadonlyWorkspaceAttachments(entry.worktree)
    for (let i = 0; i < attachments.length; i += 1) {
      if (attachments[i].type !== 'issue') {
        matched.push(entry)
        break
      }
    }
  }
  return matched
}

export function createWorkspaceReferenceRefreshTargetsSelector(options?: {
  selectedOnly?: boolean
}) {
  let workspaces: ReturnType<typeof workspaceReferenceWorkspaces> = []
  let initialized = false
  let prevTabsByWorktree: AppState['tabsByWorktree'] | undefined
  let prevPtyIdsByTabId: AppState['ptyIdsByTabId'] | undefined
  let prevBrowserTabsByWorktree: AppState['browserTabsByWorktree'] | undefined
  let prevUnifiedTabsByWorktree: AppState['unifiedTabsByWorktree'] | undefined
  let prevStructuredChatSleptAtByPaneKey: AppState['structuredChatSleptAtByPaneKey'] | undefined
  let prevAgentStatusByPaneKey: AppState['agentStatusByPaneKey'] | undefined
  let prevAgentStatusEpoch: AppState['agentStatusEpoch'] | undefined
  let sleeping = new Map<string, boolean>()
  let liveWorktreeIds: ReadonlySet<string> = new Set()
  let result: VisibleHostedReviewRefreshTarget[] = []
  return (state: AppState, reviewInputsChanged: boolean): VisibleHostedReviewRefreshTarget[] => {
    const reset = !initialized || reviewInputsChanged
    if (reset) {
      workspaces = workspaceReferenceWorkspaces(state, options)
    }
    const topologyInputsChanged =
      state.tabsByWorktree !== prevTabsByWorktree ||
      state.ptyIdsByTabId !== prevPtyIdsByTabId ||
      state.browserTabsByWorktree !== prevBrowserTabsByWorktree ||
      state.unifiedTabsByWorktree !== prevUnifiedTabsByWorktree ||
      state.structuredChatSleptAtByPaneKey !== prevStructuredChatSleptAtByPaneKey
    if (
      !reset &&
      !topologyInputsChanged &&
      state.agentStatusByPaneKey === prevAgentStatusByPaneKey &&
      state.agentStatusEpoch === prevAgentStatusEpoch
    ) {
      return result
    }
    initialized = true
    prevTabsByWorktree = state.tabsByWorktree
    prevPtyIdsByTabId = state.ptyIdsByTabId
    prevBrowserTabsByWorktree = state.browserTabsByWorktree
    prevUnifiedTabsByWorktree = state.unifiedTabsByWorktree
    prevStructuredChatSleptAtByPaneKey = state.structuredChatSleptAtByPaneKey
    prevAgentStatusByPaneKey = state.agentStatusByPaneKey
    prevAgentStatusEpoch = state.agentStatusEpoch
    const topologyChanged = reset || topologyInputsChanged
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
    const cadenceHost = getPRRefreshOwnerRuntimeEnvironmentId(candidate)
    const cadence = hostPRAutoRefreshCadence(cadenceHost)
    for (const item of getReadonlyWorkspaceAttachments(worktree)) {
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
      const intervalInput = {
        state: review?.state,
        checksStatus: review?.status,
        hasReview: review ? true : null,
        selected
      }
      targets.set(key, {
        key,
        revision: key,
        selected,
        fetchedAt: entry?.fetchedAt ?? null,
        cadence,
        cadenceHost,
        intervalMs: reviewRefreshIntervalMs(intervalInput, cadence),
        foregroundIntervalMs: reviewRefreshIntervalMs(intervalInput, 'default'),
        refresh: (_force, signal, intent) =>
          withTimeout(
            readWorkspaceReferenceDetails(
              {
                ...request,
                admissionTier: selected ? 'interactive' : 'background',
                // A timer's reread is a poll: no use of an idle WSL host (#46567).
                background: intent === 'timer' || intent === 'retry' || undefined
              },
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
