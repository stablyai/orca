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
import {
  createWorktreeAgentFreshnessSelector,
  EMPTY_WORKTREE_AGENT_FRESHNESS_SIGNATURE
} from './worktree-agent-freshness-selector'
import {
  attachAgentLiveWorktreeMismatch,
  buildAgentLiveWorktreeMismatchCandidates
} from './agent-live-worktree-mismatch'
import type { Repo, Worktree } from '../../../../shared/types'

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
export function useWorktreeAgentRows(
  worktreeId: string,
  active = true,
  /** Concrete owner records; IDs alone can collide across hosts. */
  owner?: { worktree: Worktree; repo: Repo }
): DashboardAgentRow[] {
  const selectAgentFreshness = useMemo(
    () => createWorktreeAgentFreshnessSelector(worktreeId),
    [worktreeId]
  )
  const tabs = useAppStore((s) => (active ? s.tabsByWorktree[worktreeId] : undefined))
  // Why: narrow the subscriptions to only THIS worktree's entries via
  // useShallow. Subscribing to the whole agentStatusByPaneKey map would make
  // every on-screen card re-render on any agent-status update anywhere —
  // O(worktrees²) render amplification. Pre-filtering here means the card
  // only re-renders when something relevant to THIS worktree changes.
  const liveEntries = useAppStore(
    useShallow((s) => (active ? selectLiveAgentStatusEntriesForWorktree(s, worktreeId) : []))
  )
  // Why: keep the store selector limited to stable raw records. Converting
  // migration entries creates fresh objects with Date.now(), which breaks
  // useSyncExternalStore's cached-snapshot contract and can blank Electron.
  const migrationUnsupported = useAppStore(
    useShallow((s) => (active ? selectMigrationUnsupportedEntriesForWorktree(s, worktreeId) : []))
  )
  const retained = useAppStore(
    useShallow((s) => (active ? selectRetainedAgentEntriesForWorktree(s, worktreeId) : []))
  )
  const runtimePaneTitlesByTabId = useAppStore(
    useShallow((s) => (active ? selectRuntimePaneTitlesForWorktree(s, worktreeId) : {}))
  )
  const ptyIdsByTabId = useAppStore(
    useShallow((s) => (active ? selectLivePtyIdsForWorktree(s, worktreeId) : {}))
  )
  const terminalLayoutsByTabId = useAppStore(
    useShallow((s) => (active ? selectTerminalLayoutsForWorktree(s, worktreeId) : {}))
  )
  const runtimeAgentOrchestrationByPaneKey = useAppStore(
    useShallow((s) => (active ? selectRuntimeAgentOrchestrationForWorktree(s, worktreeId) : {}))
  )
  const agentFreshnessSignature = useAppStore((s) =>
    active ? selectAgentFreshness(s) : EMPTY_WORKTREE_AGENT_FRESHNESS_SIGNATURE
  )
  // Why: scope catalog subscriptions to the owner repo so scratch-worktree
  // discovery recomputes this card without polling or a global status listener.
  const ownerRepoId = owner?.repo.id
  const visibleWorktrees = useAppStore((s) =>
    active && ownerRepoId ? s.worktreesByRepo[ownerRepoId] : undefined
  )
  const detectedWorktrees = useAppStore((s) =>
    active && ownerRepoId ? s.detectedWorktreesByRepo[ownerRepoId] : undefined
  )
  const ownerWorktree = owner?.worktree
  const ownerRepo = owner?.repo
  const mismatchCandidates = useMemo(
    () =>
      ownerWorktree && ownerRepo
        ? buildAgentLiveWorktreeMismatchCandidates({
            ownerWorktree,
            ownerRepo,
            visibleWorktrees,
            detected: detectedWorktrees
          })
        : [],
    [ownerWorktree, ownerRepo, visibleWorktrees, detectedWorktrees]
  )

  const rows = useMemo<DashboardAgentRow[]>(() => {
    if (!active) {
      return []
    }
    // Why: Date.now() is read inside the memo so stale-decay recalculates when
    // this worktree's freshness signature changes, even without new PTY data.
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
    active,
    tabs,
    liveEntries,
    migrationUnsupported,
    retained,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    runtimeAgentOrchestrationByPaneKey,
    agentFreshnessSignature
  ])

  return useMemo(
    () =>
      ownerWorktree && ownerRepo && mismatchCandidates.length > 0
        ? attachAgentLiveWorktreeMismatch(rows, {
            ownerWorktree,
            ownerRepo,
            candidates: mismatchCandidates
          })
        : rows,
    [rows, ownerWorktree, ownerRepo, mismatchCandidates]
  )
}
