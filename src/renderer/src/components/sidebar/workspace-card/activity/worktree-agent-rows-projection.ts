import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { isExecutionHostAliasForWorktree } from '@/lib/workspace/ownership/worktree-execution-host-alias'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { applyAgentRowLineage } from '@/components/dashboard/agent-row-lineage'
import type { AppState } from '@/store/types'

import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getAgentPaneExecutionHost } from '@/store/slices/agent-status/agent-pane-execution-host'

export const EMPTY_AGENT_ROWS: DashboardAgentRow[] = []

function rowBelongsToHost(
  state: AppState,
  row: DashboardAgentRow,
  hostId: ExecutionHostId,
  owner: ReturnType<typeof resolveQualifiedWorktreeExecutionOwner> | undefined,
  stampedHosts: ReadonlyMap<string, ExecutionHostId | undefined>
): boolean {
  const paneKey = row.activationPaneKey ?? row.paneKey
  const entry = state.agentStatusByPaneKey.get(paneKey) ?? row.entry
  const paneHost = getAgentPaneExecutionHost(
    state,
    paneKey,
    entry,
    row.tab.ptyId,
    stampedHosts.get(row.tab.id)
  )
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

/** Which host this workspace's rows run on, and the store inputs that answer can change with. */
function createHostOwnership(worktreeId: string, hostId: ExecutionHostId) {
  let ownerTabs: ReturnType<typeof getStructuredAgentSessionTabsByPaneKey> | undefined
  let needsWorkspaceOwner = false
  return (state: AppState) => {
    const representedTabs = getStructuredAgentSessionTabsByPaneKey(
      state.unifiedTabsByWorktree[worktreeId]
    )
    const workspaceOwner = resolveQualifiedWorktreeExecutionOwner(
      selectWorktreesByRepo(state),
      state.repos,
      worktreeId,
      hostId
    )
    if (ownerTabs !== representedTabs) {
      ownerTabs = representedTabs
      needsWorkspaceOwner = false
      for (const tab of representedTabs.values()) {
        if (!tab.executionHostId) {
          needsWorkspaceOwner = true
          break
        }
      }
    }
    let stampedHosts: Map<string, ExecutionHostId | undefined> | undefined
    return {
      inputs: [
        representedTabs,
        state.unifiedTabsByWorktree[worktreeId],
        workspaceOwner?.hostId,
        workspaceOwner?.worktree.runtimeOwnerEnvironmentId,
        workspaceOwner?.worktree.hostId,
        ...(needsWorkspaceOwner ? structuredAgentSessionOwnerInputs(state) : []),
        state.terminalLayoutsByTabId,
        state.ptyIdsByTabId
      ],
      belongs: (row: DashboardAgentRow): boolean => {
        stampedHosts ??= new Map(
          (state.unifiedTabsByWorktree[worktreeId] ?? [])
            .filter((tab) => tab.contentType === 'terminal')
            .map((tab) => [tab.entityId, tab.executionHostId])
        )
        return rowBelongsToHost(state, row, hostId, workspaceOwner, stampedHosts)
      }
    }
  }
}

function sameInputs(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))
  )
}

/** The row model shared by mounted cards and hidden-workspace summaries. */
export function createWorktreeAgentRowsSelector(worktreeId: string, hostId?: ExecutionHostId) {
  const ownership = hostId ? createHostOwnership(worktreeId, hostId) : null
  let previous: readonly unknown[] = []
  let result = EMPTY_AGENT_ROWS
  return (state: AppState): DashboardAgentRow[] => {
    // The keyed projection owns the workspace's rows; a host only filters them.
    const rows = state.agentStatusByPaneKey.projection.list(worktreeId)
    if (!ownership) {
      return rows
    }
    const host = ownership(state)
    const inputs = [rows, ...host.inputs]
    if (sameInputs(inputs, previous)) {
      return result
    }
    previous = inputs
    const owned = rows.filter(host.belongs)
    // Same-ID twins on another host are rare; an unfiltered list keeps the projection's rows.
    result = owned.length === rows.length ? rows : applyAgentRowLineage(owned)
    return result
  }
}

/** Root keys a host-scoped card renders; returns `keys` itself while every row is on the host. */
export function createWorktreeAgentHostKeysSelector(worktreeId: string, hostId: ExecutionHostId) {
  const ownership = createHostOwnership(worktreeId, hostId)
  let previous: readonly unknown[] = []
  let result: readonly string[] = []
  return (state: AppState, keys: readonly string[]): readonly string[] => {
    const projection = state.agentStatusByPaneKey.projection
    const rows = keys.map((key) => projection.row(key))
    const host = ownership(state)
    const inputs = [keys, ...rows, ...host.inputs]
    if (sameInputs(inputs, previous)) {
      return result
    }
    previous = inputs
    const owned = keys.filter((_, index) => {
      const row = rows[index]
      return !row || host.belongs(row)
    })
    result = owned.length === keys.length ? keys : owned
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
