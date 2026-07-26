import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import type { DashboardBucket } from '../../../../shared/dashboard-snapshot'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'

export type AgentBucketCounts = Record<DashboardBucket, number>

const EMPTY_COUNTS: AgentBucketCounts = { attention: 0, working: 0, idle: 0 }

/**
 * Per-state agent counts for the sidebar dashboard entry, derived from the same
 * builder that feeds the pop-out board so the numbers always agree. Recomputes
 * only when an input slice changes (mirrors useDashboardData's cost profile).
 */
export function useAgentBucketCounts(): AgentBucketCounts {
  const {
    repos,
    worktreesByRepo,
    tabsByWorktree,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    agentStatusEpoch
  } = useAppStore(
    useShallow((s) => ({
      repos: s.repos,
      worktreesByRepo: s.worktreesByRepo,
      tabsByWorktree: s.tabsByWorktree,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      retainedAgentsByPaneKey: s.retainedAgentsByPaneKey,
      migrationUnsupportedByPtyId: s.migrationUnsupportedByPtyId,
      runtimeAgentOrchestrationByPaneKey: s.runtimeAgentOrchestrationByPaneKey,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      agentStatusEpoch: s.agentStatusEpoch
    }))
  )

  return useMemo(() => {
    const snapshot = buildDashboardSnapshot(
      {
        repos,
        worktreesByRepo,
        tabsByWorktree,
        agentStatusByPaneKey,
        retainedAgentsByPaneKey,
        migrationUnsupportedByPtyId,
        runtimeAgentOrchestrationByPaneKey,
        terminalLayoutsByTabId,
        ptyIdsByTabId,
        runtimePaneTitlesByTabId,
        // Counts do not render acknowledgement state, so avoid subscribing the sidebar to it.
        acknowledgedAgentsByPaneKey: {}
      },
      Date.now()
    )
    if (snapshot.cards.length === 0) {
      return EMPTY_COUNTS
    }
    const counts: AgentBucketCounts = { attention: 0, working: 0, idle: 0 }
    for (const card of snapshot.cards) {
      counts[card.bucket] += 1
    }
    return counts
    // Why: Date.now() is read inside the memo (not a dep) so idle-decay tracks
    // agentStatusEpoch ticks, matching useDashboardData.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    repos,
    worktreesByRepo,
    tabsByWorktree,
    agentStatusByPaneKey,
    retainedAgentsByPaneKey,
    migrationUnsupportedByPtyId,
    runtimeAgentOrchestrationByPaneKey,
    terminalLayoutsByTabId,
    ptyIdsByTabId,
    runtimePaneTitlesByTabId,
    agentStatusEpoch
  ])
}
