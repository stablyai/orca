import { useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import {
  buildDashboardBucketCounts,
  createDashboardBucketCountsCache
} from './build-dashboard-bucket-counts'

export type AgentBucketCounts = Record<DashboardBucket, number>

/**
 * Per-state agent counts for the sidebar dashboard entry, using the same row
 * and bucket derivation as the pop-out board without allocating its cards.
 * Recomputes only when an input slice changes.
 */
export function useAgentBucketCounts(): AgentBucketCounts {
  const {
    repos,
    worktreesByRepo,
    tabsByWorktree,
    unifiedTabsByWorktree,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    folderWorkspaces,
    acknowledgedAgentsByPaneKey,
    agentStatusEpoch
  } = useAppStore(
    useShallow((s) => ({
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
      agentStatusEpoch: s.agentStatusEpoch
    }))
  )

  // Why a per-hook cache: unrelated status/title writes change one worktree's inputs;
  // the cache keeps every other worktree's counts without rerunning its row pipeline.
  const cacheRef = useRef(createDashboardBucketCountsCache())
  return useMemo(() => {
    return buildDashboardBucketCounts(
      {
        repos,
        worktreesByRepo,
        tabsByWorktree,
        unifiedTabsByWorktree,
        agentStatusByPaneKey,
        retainedAgentsByPaneKey,
        migrationUnsupportedByPtyId,
        runtimeAgentOrchestrationByPaneKey,
        terminalLayoutsByTabId,
        ptyIdsByTabId,
        runtimePaneTitlesByTabId,
        folderWorkspaces,
        acknowledgedAgentsByPaneKey,
        // Same: counts never render a card's conversation name, so the
        // generated-title gate is moot and the sidebar stays off settings.
        settings: null
      },
      Date.now(),
      cacheRef.current,
      // Why: time-based freshness decay is signaled by agentStatusEpoch; it invalidates
      // every cached worktree so stale-decayed buckets recount.
      agentStatusEpoch
    )
    // Why: Date.now() is read inside the memo (not a dep) so idle-decay tracks
    // agentStatusEpoch ticks, matching useDashboardData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    repos,
    worktreesByRepo,
    tabsByWorktree,
    unifiedTabsByWorktree,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    folderWorkspaces,
    acknowledgedAgentsByPaneKey,
    agentStatusEpoch
  ])
}
