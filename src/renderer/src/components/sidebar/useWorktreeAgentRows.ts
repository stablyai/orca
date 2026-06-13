import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import { migrationUnsupportedToAgentStatusEntry } from '@/lib/migration-unsupported-agent-entry'
import { useAppStore } from '@/store'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRuntimeAgentOrchestrationForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from './worktree-agent-row-selectors'

export { buildWorktreeAgentRows } from './worktree-agent-rows'
export {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRuntimeAgentOrchestrationForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './worktree-agent-row-selectors'

/**
 * Narrow per-worktree agent row hook used by the WorktreeCard inline agents
 * list. Produces live hook-reported agents plus retained "done" snapshots,
 * stale-decayed to 'idle' when the hook stream has gone quiet.
 *
 * Uses indexed per-worktree selectors rather than reusing useDashboardData's
 * cross-worktree aggregate. The index is rebuilt once per relevant immutable
 * store slice and then shared by every visible card, avoiding O(cards × agents)
 * selector work on high-frequency agent status pings.
 */
export function useWorktreeAgentRows(worktreeId: string): DashboardAgentRow[] {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId])
  // Why: narrow the subscriptions to only THIS worktree's entries via
  // useShallow. Subscribing to the whole agentStatusByPaneKey map would make
  // every on-screen card re-render on any agent-status update anywhere —
  // O(worktrees²) render amplification. Pre-filtering here means the card
  // only re-renders when something relevant to THIS worktree changes.
  const liveEntries = useAppStore(
    useShallow((s) => selectLiveAgentStatusEntriesForWorktree(s, worktreeId))
  )
  // Why: keep the store selector limited to stable raw records. Converting
  // migration entries creates fresh objects with Date.now(), which breaks
  // useSyncExternalStore's cached-snapshot contract and can blank Electron.
  const migrationUnsupported = useAppStore(
    useShallow((s) => selectMigrationUnsupportedEntriesForWorktree(s, worktreeId))
  )
  const retained = useAppStore(
    useShallow((s) => selectRetainedAgentEntriesForWorktree(s, worktreeId))
  )
  const runtimePaneTitlesByTabId = useAppStore(
    useShallow((s) => selectRuntimePaneTitlesForWorktree(s, worktreeId))
  )
  const ptyIdsByTabId = useAppStore(useShallow((s) => selectLivePtyIdsForWorktree(s, worktreeId)))
  const terminalLayoutsByTabId = useAppStore(
    useShallow((s) => selectTerminalLayoutsForWorktree(s, worktreeId))
  )
  const runtimeAgentOrchestrationByPaneKey = useAppStore(
    useShallow((s) => selectRuntimeAgentOrchestrationForWorktree(s, worktreeId))
  )
  // Why: agentStatusEpoch is included in the dependency array (but not in the
  // computation itself) so the memo recomputes when freshness boundaries
  // expire, even if no new PTY data arrives — same rationale as
  // useDashboardData.
  const agentStatusEpoch = useAppStore((s) => s.agentStatusEpoch)

  return useMemo<DashboardAgentRow[]>(() => {
    // Why: Date.now() is read inside the memo (not as a dep) so stale-decay
    // recalculates whenever agentStatusEpoch ticks — same pattern as
    // useDashboardData.
    const now = Date.now()
    const entries =
      migrationUnsupported.length > 0
        ? [
            ...liveEntries,
            ...migrationUnsupported.flatMap((unsupported) => {
              const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
              return entry ? [entry] : []
            })
          ]
        : liveEntries
    return applyAgentRowLineage(
      buildWorktreeAgentRows({
        tabs: tabs ?? [],
        entries,
        retained,
        runtimePaneTitlesByTabId,
        ptyIdsByTabId,
        terminalLayoutsByTabId,
        runtimeAgentOrchestrationByPaneKey,
        now
      })
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tabs,
    liveEntries,
    migrationUnsupported,
    retained,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    runtimeAgentOrchestrationByPaneKey,
    agentStatusEpoch
  ])
}
