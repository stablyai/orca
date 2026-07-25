import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'

/**
 * Builds the dashboard snapshot directly from the live renderer store for the
 * in-window screen popover. The pop-out window can't read this store, so it
 * relays a serialized snapshot instead (useDashboardSnapshot); in-window there
 * is no relay, so we derive it here from the same builder the bridge uses.
 */
export function useLiveDashboardSnapshot(): DashboardSnapshot {
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const agentStatusByPaneKey = useAppStore((s) => s.agentStatusByPaneKey)
  const retainedAgentsByPaneKey = useAppStore((s) => s.retainedAgentsByPaneKey)
  const migrationUnsupportedByPtyId = useAppStore((s) => s.migrationUnsupportedByPtyId)
  const runtimeAgentOrchestrationByPaneKey = useAppStore(
    (s) => s.runtimeAgentOrchestrationByPaneKey
  )
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const runtimePaneTitlesByTabId = useAppStore((s) => s.runtimePaneTitlesByTabId)
  const acknowledgedAgentsByPaneKey = useAppStore((s) => s.acknowledgedAgentsByPaneKey)
  // Why: freshness can flip a bucket without any backing map changing; the epoch
  // ticks on the freshness boundary so the memo re-derives stale-decayed cards.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  return useMemo(
    // Why: Date.now() is read inside the memo (not a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks, matching useDashboardData.
    () =>
      buildDashboardSnapshot(
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
          acknowledgedAgentsByPaneKey
        },
        Date.now()
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
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
      acknowledgedAgentsByPaneKey,
      agentStatusEpoch
    ]
  )
}
