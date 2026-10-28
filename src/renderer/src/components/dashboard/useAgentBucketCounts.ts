import { useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import {
  buildDashboardBucketCounts,
  createDashboardBucketCountsCache
} from './build-dashboard-bucket-counts'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

export type AgentBucketCounts = Record<DashboardBucket, number>

/** The bucket-count inputs, shaped so it doubles as the snapshot state passed to the builder. */
export type AgentBucketCountState = Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'paneForegroundAgentByPaneKey'
  | 'folderWorkspaces'
  | 'acknowledgedAgentsByPaneKey'
  | 'agentStatusEpoch'
> & {
  // Counts never render generated conversation names; keep this path off settings subscriptions.
  settings: null
}

// Compare slice identities directly: useShallow allocates entries/Maps per store write. This pure state projection shares one allocation-free unchanged path across consumers.
let previousState: AgentBucketCountState | null = null

/** Test-only: drop the cross-render identity gate so a case starts cold. */
export function resetAgentBucketCountStateForTests(): void {
  previousState = null
}

export function selectAgentBucketCountState(s: AppState): AgentBucketCountState {
  const previous = previousState
  if (
    previous !== null &&
    previous.repos === s.repos &&
    selectWorktreesByRepo(previous) === selectWorktreesByRepo(s) &&
    previous.tabsByWorktree === s.tabsByWorktree &&
    previous.unifiedTabsByWorktree === s.unifiedTabsByWorktree &&
    previous.agentStatusByPaneKey === s.agentStatusByPaneKey &&
    previous.retainedAgentsByPaneKey === s.retainedAgentsByPaneKey &&
    previous.migrationUnsupportedByPtyId === s.migrationUnsupportedByPtyId &&
    previous.runtimeAgentOrchestrationByPaneKey === s.runtimeAgentOrchestrationByPaneKey &&
    previous.terminalLayoutsByTabId === s.terminalLayoutsByTabId &&
    previous.ptyIdsByTabId === s.ptyIdsByTabId &&
    previous.runtimePaneTitlesByTabId === s.runtimePaneTitlesByTabId &&
    previous.paneForegroundAgentByPaneKey === s.paneForegroundAgentByPaneKey &&
    selectFolderWorkspaces(previous) === selectFolderWorkspaces(s) &&
    previous.acknowledgedAgentsByPaneKey === s.acknowledgedAgentsByPaneKey &&
    previous.agentStatusEpoch === s.agentStatusEpoch
  ) {
    return previous
  }
  previousState = {
    repos: s.repos,
    worktreesByRepo: selectWorktreesByRepo(s),
    tabsByWorktree: s.tabsByWorktree,
    unifiedTabsByWorktree: s.unifiedTabsByWorktree,
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    ptyIdsByTabId: s.ptyIdsByTabId,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    paneForegroundAgentByPaneKey: s.paneForegroundAgentByPaneKey,
    folderWorkspaces: selectFolderWorkspaces(s),
    acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
    agentStatusEpoch: s.agentStatusEpoch,
    settings: null
  }
  return previousState
}

/** Derive sidebar buckets with shared board rules without allocating cards; subscribe only to relevant input slices. */
export function useAgentBucketCounts(): AgentBucketCounts {
  const state = useAppStore(selectAgentBucketCountState)
  // Cache per worktree so status/title churn in one workspace does not rebuild every row pipeline.
  const cacheRef = useRef<ReturnType<typeof createDashboardBucketCountsCache>>(undefined!)
  cacheRef.current ??= createDashboardBucketCountsCache()
  return useMemo(() => {
    // Freshness follows agentStatusEpoch in state; read the clock when that generation invalidates the memo, not as a dependency.
    // oxlint-disable-next-line react/purity -- wall time is sampled per epoch tick, as explained above.
    return buildDashboardBucketCounts(state, Date.now(), cacheRef.current, state.agentStatusEpoch)
  }, [state])
}
