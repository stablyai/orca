import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import { migrationUnsupportedToAgentStatusEntry } from '../../../../../../shared/migration-unsupported-agent-entry'
import type { AppState } from '@/store/types'
import {
  selectLivePtyIdsForWorktree,
  selectPaneForegroundAgentsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import {
  selectLiveAgentStatusEntriesForWorktree,
  selectMigrationUnsupportedEntriesForWorktree,
  selectRetainedAgentEntriesForWorktree,
  selectTerminalLayoutsForWorktree
} from './worktree-agent-row-selectors'
import { selectWorktreeAgentOrchestration as selectRuntimeAgentOrchestrationForWorktree } from './worktree-agent-orchestration-index'

import { EMPTY_TABS } from './worktree-card-empty-inputs'
import { createWorktreeAgentFreshnessSelector } from './worktree-agent-freshness-selector'

import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getAgentPaneExecutionHost } from '@/store/slices/agent-status/agent-pane-execution-host'

export const EMPTY_AGENT_ROWS: DashboardAgentRow[] = []

function rowBelongsToHost(
  state: AppState,
  row: DashboardAgentRow,
  hostId: ExecutionHostId
): boolean {
  const paneKey = row.activationPaneKey ?? row.paneKey
  const entry =
    state.agentStatusByPaneKey[paneKey] ??
    state.retainedAgentsByPaneKey[paneKey]?.entry ??
    row.entry
  return getAgentPaneExecutionHost(state, paneKey, entry, row.tab.ptyId) === hostId
}

/** The row model shared by mounted cards and hidden-workspace summaries. */
export function createWorktreeAgentRowsSelector(worktreeId: string, hostId?: ExecutionHostId) {
  const selectFreshness = createWorktreeAgentFreshnessSelector(worktreeId, () => Date.now())
  let previous: readonly unknown[] = []
  let result = EMPTY_AGENT_ROWS
  return (state: AppState): DashboardAgentRow[] => {
    const tabs = state.tabsByWorktree[worktreeId] ?? EMPTY_TABS
    const liveEntries = selectLiveAgentStatusEntriesForWorktree(state, worktreeId)
    const migrationUnsupported = selectMigrationUnsupportedEntriesForWorktree(state, worktreeId)
    const retained = selectRetainedAgentEntriesForWorktree(state, worktreeId)
    const runtimePaneTitlesByTabId = selectRuntimePaneTitlesForWorktree(state, worktreeId)
    const ptyIdsByTabId = selectLivePtyIdsForWorktree(state, worktreeId)
    const terminalLayoutsByTabId = selectTerminalLayoutsForWorktree(state, worktreeId)
    const runtimeAgentOrchestrationByPaneKey = selectRuntimeAgentOrchestrationForWorktree(
      state,
      worktreeId
    )
    const paneForegroundAgentByPaneKey = selectPaneForegroundAgentsForWorktree(state, worktreeId)
    const representedTabs = getStructuredAgentSessionTabsByPaneKey(
      state.unifiedTabsByWorktree[worktreeId]
    )
    const inputs = [
      tabs,
      liveEntries,
      migrationUnsupported,
      retained,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      terminalLayoutsByTabId,
      runtimeAgentOrchestrationByPaneKey,
      paneForegroundAgentByPaneKey,
      selectFreshness(state),
      representedTabs,
      ...(hostId ? structuredAgentSessionOwnerInputs(state) : [])
    ]
    if (inputs.every((value, index) => Object.is(value, previous[index]))) {
      return result
    }
    previous = inputs
    const entries =
      migrationUnsupported.length > 0
        ? [
            ...liveEntries,
            ...migrationUnsupported.flatMap((unsupported) => {
              const entry = migrationUnsupportedToAgentStatusEntry(unsupported)
              return entry ? [{ ...entry, terminalHandle: unsupported.ptyId }] : []
            })
          ]
        : liveEntries
    const rows = buildWorktreeAgentRows({
      tabs,
      representedTabs,
      entries,
      retained,
      runtimePaneTitlesByTabId,
      ptyIdsByTabId,
      terminalLayoutsByTabId,
      runtimeAgentOrchestrationByPaneKey,
      paneForegroundAgentByPaneKey,
      now: Date.now()
    })
    result = applyAgentRowLineage(
      hostId ? rows.filter((row) => rowBelongsToHost(state, row, hostId)) : rows
    )
    return result
  }
}

/** Structural changes can alter agent ownership; live status and acknowledgements invalidate only their owners. */
export function worktreeAgentStructureInputs(state: AppState): readonly unknown[] {
  return [
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    state.migrationUnsupportedByPtyId,
    state.retainedAgentsByPaneKey,
    state.ptyIdsByTabId,
    state.terminalLayoutsByTabId,
    state.runtimeAgentOrchestrationByPaneKey,
    state.paneForegroundAgentByPaneKey,
    selectWorktreesByRepo(state),
    ...structuredAgentSessionOwnerInputs(state)
  ]
}

export function worktreeAgentProjectionInputs(state: AppState): readonly unknown[] {
  return [
    ...worktreeAgentStructureInputs(state),
    state.runtimePaneTitlesByTabId,
    state.agentStatusByPaneKey,
    state.agentStatusEpoch,
    state.acknowledgedAgentsByPaneKey
  ]
}
