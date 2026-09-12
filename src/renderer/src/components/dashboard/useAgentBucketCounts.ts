import { useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import {
  buildDashboardBucketCounts,
  createDashboardBucketCountsCache
} from './build-dashboard-bucket-counts'

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
  | 'folderWorkspaces'
  | 'acknowledgedAgentsByPaneKey'
  | 'agentStatusEpoch'
> & {
  // Why null: counts never render a card's conversation name, so the
  // generated-title gate is moot and the sidebar stays off settings.
  settings: null
}

// Why module scope rather than useShallow: zustand runs this selector on every
// store write, and shallow() on a plain object takes the compareEntries path —
// two Object.entries arrays, 28 tuples and two Maps allocated per write just to
// conclude nothing moved. Fourteen `===` against the previous slices allocates
// nothing on the unchanged path, and the result is a pure function of the state
// so one gate can serve every mounted consumer.
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
    previous.worktreesByRepo === s.worktreesByRepo &&
    previous.tabsByWorktree === s.tabsByWorktree &&
    previous.unifiedTabsByWorktree === s.unifiedTabsByWorktree &&
    previous.agentStatusByPaneKey === s.agentStatusByPaneKey &&
    previous.retainedAgentsByPaneKey === s.retainedAgentsByPaneKey &&
    previous.migrationUnsupportedByPtyId === s.migrationUnsupportedByPtyId &&
    previous.runtimeAgentOrchestrationByPaneKey === s.runtimeAgentOrchestrationByPaneKey &&
    previous.terminalLayoutsByTabId === s.terminalLayoutsByTabId &&
    previous.ptyIdsByTabId === s.ptyIdsByTabId &&
    previous.runtimePaneTitlesByTabId === s.runtimePaneTitlesByTabId &&
    previous.folderWorkspaces === s.folderWorkspaces &&
    previous.acknowledgedAgentsByPaneKey === s.acknowledgedAgentsByPaneKey &&
    previous.agentStatusEpoch === s.agentStatusEpoch
  ) {
    return previous
  }
  previousState = {
    repos: s.repos,
    worktreesByRepo: s.worktreesByRepo,
    tabsByWorktree: s.tabsByWorktree,
    unifiedTabsByWorktree: s.unifiedTabsByWorktree,
    agentStatusByPaneKey: s.agentStatusByPaneKey,
    retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId: s.terminalLayoutsByTabId,
    ptyIdsByTabId: s.ptyIdsByTabId,
    runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
    folderWorkspaces: s.folderWorkspaces,
    acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey,
    agentStatusEpoch: s.agentStatusEpoch,
    settings: null
  }
  return previousState
}

/**
 * Per-state agent counts for the sidebar dashboard entry, using the same row
 * and bucket derivation as the pop-out board without allocating its cards.
 * Recomputes only when an input slice changes.
 */
export function useAgentBucketCounts(): AgentBucketCounts {
  const state = useAppStore(selectAgentBucketCountState)
  // Why a per-hook cache: unrelated status/title writes change one worktree's inputs;
  // the cache keeps every other worktree's rows without rerunning its row pipeline.
  const cacheRef = useRef<ReturnType<typeof createDashboardBucketCountsCache>>(undefined!)
  cacheRef.current ??= createDashboardBucketCountsCache()
  return useMemo(() => {
    // Why Date.now() is read here and not a dep: idle-decay tracks agentStatusEpoch
    // ticks (carried in `state`), matching useDashboardData. That epoch doubles as the
    // cache generation, so a stale-boundary tick recounts every decayed bucket.
    return buildDashboardBucketCounts(state, Date.now(), cacheRef.current, state.agentStatusEpoch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])
}
