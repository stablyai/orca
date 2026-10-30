import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/structured-agent-session-tabs'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../shared/migration-unsupported-agent-entry'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import {
  EMPTY_LIVE_PTY_IDS,
  EMPTY_PANE_FOREGROUND_AGENTS,
  EMPTY_RUNTIME_PANE_TITLES,
  selectLivePtyIdsForWorktree,
  selectPaneForegroundAgentsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import {
  EMPTY_LIVE_ENTRIES,
  EMPTY_MIGRATION_UNSUPPORTED_ENTRIES,
  EMPTY_RETAINED,
  EMPTY_TERMINAL_LAYOUTS,
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRuntimeAgentOrchestrationForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from './worktree-agent-row-selectors'
import { EMPTY_WORKTREE_AGENT_ORCHESTRATION } from './worktree-agent-orchestration-index'
import { EMPTY_TABS } from './WorktreeCardHelpers'
import {
  createWorktreeAgentFreshnessSelector,
  EMPTY_WORKTREE_AGENT_FRESHNESS_SIGNATURE
} from './worktree-agent-freshness-selector'

// Why frozen: shared by every inactive card, and callers only read these rows.
const EMPTY_AGENT_ROWS = Object.freeze([]) as unknown as DashboardAgentRow[]
const subscribeToNothing = (): (() => void) => () => {}

export { buildWorktreeAgentRows } from './worktree-agent-rows'
export {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRuntimeAgentOrchestrationForWorktree,
  selectRetainedAgentEntriesForWorktree
} from './worktree-agent-row-selectors'

/** Share indexed worktree inputs across cards; derive live/retained row freshness from the available evidence. */
export function useWorktreeAgentRows(worktreeId: string, active = true): DashboardAgentRow[] {
  const selectInputs = useMemo(() => {
    const selectAgentFreshness = createWorktreeAgentFreshnessSelector(worktreeId)
    const readInputs = (state: AppState) =>
      [
        active ? state.tabsByWorktree[worktreeId] : EMPTY_TABS,
        active ? selectLiveAgentStatusEntriesForWorktree(state, worktreeId) : EMPTY_LIVE_ENTRIES,
        active
          ? selectMigrationUnsupportedEntriesForWorktree(state, worktreeId)
          : EMPTY_MIGRATION_UNSUPPORTED_ENTRIES,
        active ? selectRetainedAgentEntriesForWorktree(state, worktreeId) : EMPTY_RETAINED,
        active ? selectRuntimePaneTitlesForWorktree(state, worktreeId) : EMPTY_RUNTIME_PANE_TITLES,
        active ? selectLivePtyIdsForWorktree(state, worktreeId) : EMPTY_LIVE_PTY_IDS,
        active ? selectTerminalLayoutsForWorktree(state, worktreeId) : EMPTY_TERMINAL_LAYOUTS,
        active
          ? selectRuntimeAgentOrchestrationForWorktree(state, worktreeId)
          : EMPTY_WORKTREE_AGENT_ORCHESTRATION,
        active
          ? selectPaneForegroundAgentsForWorktree(state, worktreeId)
          : EMPTY_PANE_FOREGROUND_AGENTS,
        active ? selectAgentFreshness(state) : EMPTY_WORKTREE_AGENT_FRESHNESS_SIGNATURE
      ] as const
    let previous: ReturnType<typeof readInputs> | undefined
    return (state: AppState) => {
      if (!active && previous) {
        return previous
      }
      const next = readInputs(state)
      // The indexed selectors preserve equal records; compare references without allocating shallow-comparison maps.
      if (previous && next.every((value, index) => Object.is(value, previous?.[index]))) {
        return previous
      }
      previous = next
      return next
    }
  }, [worktreeId, active])
  const getInputs = useCallback(() => selectInputs(useAppStore.getState()), [selectInputs])
  const [
    tabs,
    liveEntries,
    migrationUnsupported,
    retained,
    runtimePaneTitlesByTabId,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    runtimeAgentOrchestrationByPaneKey,
    paneForegroundAgentByPaneKey,
    agentFreshnessSignature
  ] = useSyncExternalStore(
    active ? useAppStore.subscribe : subscribeToNothing,
    getInputs,
    getInputs
  )

  return useMemo<DashboardAgentRow[]>(() => {
    if (!active) {
      return EMPTY_AGENT_ROWS
    }
    // Read time inside the freshness-keyed memo so rows expire without new PTY data.
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
        tabs: tabs ?? EMPTY_TABS,
        representedTabs: getStructuredAgentSessionTabsByPaneKey(
          useAppStore.getState().unifiedTabsByWorktree
        ),
        entries,
        retained,
        runtimePaneTitlesByTabId,
        ptyIdsByTabId,
        terminalLayoutsByTabId,
        runtimeAgentOrchestrationByPaneKey,
        paneForegroundAgentByPaneKey,
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
    paneForegroundAgentByPaneKey,
    agentFreshnessSignature
  ])
}
