import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { isExecutionHostAliasForWorktree } from '@/lib/workspace/ownership/worktree-execution-host-alias'
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
  hostId: ExecutionHostId,
  owner: ReturnType<typeof resolveQualifiedWorktreeExecutionOwner> | undefined
): boolean {
  const paneKey = row.activationPaneKey ?? row.paneKey
  const entry =
    state.agentStatusByPaneKey[paneKey] ??
    state.retainedAgentsByPaneKey[paneKey]?.entry ??
    row.entry
  const paneHost = getAgentPaneExecutionHost(state, paneKey, entry, row.tab.ptyId)
  return (
    paneHost === hostId ||
    Boolean(
      paneHost &&
      paneHost !== 'foreign' &&
      owner &&
      isExecutionHostAliasForWorktree(paneHost, {
        ...owner.worktree,
        hostId:
          owner.worktree.hostId ??
          (owner.worktree.runtimeOwnerEnvironmentId?.trim() ? undefined : owner.hostId)
      })
    )
  )
}

/** The row model shared by mounted cards and hidden-workspace summaries. */
export function createWorktreeAgentRowsSelector(worktreeId: string, hostId?: ExecutionHostId) {
  const selectFreshness = createWorktreeAgentFreshnessSelector(worktreeId, () => Date.now())
  let previous: readonly unknown[] = []
  let result = EMPTY_AGENT_ROWS
  let ownerTabs: ReturnType<typeof getStructuredAgentSessionTabsByPaneKey> | undefined
  let needsWorkspaceOwner = false
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
    const workspaceOwner = hostId
      ? resolveQualifiedWorktreeExecutionOwner(
          selectWorktreesByRepo(state),
          state.repos,
          worktreeId,
          hostId
        )
      : undefined
    if (hostId && ownerTabs !== representedTabs) {
      ownerTabs = representedTabs
      needsWorkspaceOwner = false
      for (const tab of representedTabs.values()) {
        if (!tab.executionHostId) {
          needsWorkspaceOwner = true
          break
        }
      }
    }
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
      workspaceOwner?.hostId,
      workspaceOwner?.worktree.runtimeOwnerEnvironmentId,
      workspaceOwner?.worktree.hostId,
      ...(needsWorkspaceOwner ? structuredAgentSessionOwnerInputs(state) : [])
    ]
    if (
      inputs.length === previous.length &&
      inputs.every((value, index) => Object.is(value, previous[index]))
    ) {
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
      hostId ? rows.filter((row) => rowBelongsToHost(state, row, hostId, workspaceOwner)) : rows
    )
    return result
  }
}

const sharedSelectors = new Map<string, ReturnType<typeof createWorktreeAgentRowsSelector>>()
const SHARED_SELECTOR_LIMIT = 2048

/**
 * One live-store row selector per workspace and host, shared by the card's own rows and the
 * lineage rollup so a status change projects the rows once. Least recently used is evicted, so
 * workspaces still being read keep their memo above the cap.
 */
export function getSharedWorktreeAgentRowsSelector(worktreeId: string, hostId?: ExecutionHostId) {
  const key = `${hostId ?? ''}\n${worktreeId}`
  let selector = sharedSelectors.get(key)
  if (selector) {
    sharedSelectors.delete(key)
  } else {
    selector = createWorktreeAgentRowsSelector(worktreeId, hostId)
    if (sharedSelectors.size >= SHARED_SELECTOR_LIMIT) {
      sharedSelectors.delete(sharedSelectors.keys().next().value!)
    }
  }
  sharedSelectors.set(key, selector)
  return selector
}

/** Structural ownership, live status, and acknowledgements used by lineage summaries. */
export function worktreeAgentProjectionInputs(state: AppState): readonly unknown[] {
  return [
    state.tabsByWorktree,
    state.unifiedTabsByWorktree,
    state.migrationUnsupportedByPtyId,
    state.retainedAgentsByPaneKey,
    state.ptyIdsByTabId,
    state.terminalLayoutsByTabId,
    state.runtimeAgentOrchestrationByPaneKey,
    state.paneForegroundAgentByPaneKey,
    ...structuredAgentSessionOwnerInputs(state),
    state.runtimePaneTitlesByTabId,
    state.agentStatusByPaneKey,
    state.agentStatusEpoch,
    state.acknowledgedAgentsByPaneKey
  ]
}
