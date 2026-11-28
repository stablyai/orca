import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { isExecutionHostAliasForWorktree } from '@/lib/workspace/ownership/worktree-execution-host-alias'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { getStructuredAgentSessionTabsByPaneKey } from '@/components/native-chat/session/status/structured-agent-session-tabs'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getAgentPaneExecutionHost } from '@/store/slices/agent-status/pane-authority/agent-pane-execution-host'
import { recordChangeReaches } from '@/store/record-transitions/keyed-record-change-reads'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'

const EMPTY_STAMPED_HOSTS: ReadonlyMap<string, ExecutionHostId | undefined> = new Map()
const EMPTY_TAB_IDS: ReadonlySet<string> = new Set()

function sameInputs(left: readonly unknown[], right: readonly unknown[]): boolean {
  if (left.length !== right.length) {
    return false
  }
  for (let i = 0; i < left.length; i += 1) {
    if (!Object.is(left[i], right[i])) {
      return false
    }
  }
  return true
}

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

/**
 * Which host this workspace's rows run on. Fixed workspace sources are compared by reference and
 * the global tab-keyed layout/PTY maps by their changed keys, so other workspaces' writes skip it.
 */
export function createWorktreeAgentHostOwnership(worktreeId: string, hostId: ExecutionHostId) {
  let ownerTabs: ReturnType<typeof getStructuredAgentSessionTabsByPaneKey> | undefined
  let needsWorkspaceOwner = false
  let prevWorktrees: ReturnType<typeof selectWorktreesByRepo>
  let prevRepos: AppState['repos'] | undefined
  let workspaceOwner: ReturnType<typeof resolveQualifiedWorktreeExecutionOwner> = null
  let recorded = false
  let prevRepresentedTabs: ReturnType<typeof getStructuredAgentSessionTabsByPaneKey> | undefined
  let prevUnifiedTabs: AppState['unifiedTabsByWorktree'][string] | undefined
  let prevOwnerHostId: ExecutionHostId | undefined
  let prevOwnerEnvId: string | undefined
  let prevOwnerWorktreeHostId: ExecutionHostId | undefined
  let prevSessionOwnerInputs: readonly unknown[] | null = null
  let layouts: AppState['terminalLayoutsByTabId'] | undefined
  let ptys: AppState['ptyIdsByTabId'] | undefined
  let tabIds: ReadonlySet<string> = EMPTY_TAB_IDS
  const readTab = (key: string): boolean => tabIds.has(key)
  const syncWorkspaceState = (state: AppState) => {
    const worktrees = selectWorktreesByRepo(state)
    if (prevWorktrees !== worktrees || prevRepos !== state.repos) {
      prevWorktrees = worktrees
      prevRepos = state.repos
      workspaceOwner = resolveQualifiedWorktreeExecutionOwner(
        worktrees,
        state.repos,
        worktreeId,
        hostId
      )
    }
    const unifiedTabs = state.unifiedTabsByWorktree[worktreeId]
    const representedTabs = getStructuredAgentSessionTabsByPaneKey(unifiedTabs)
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
    return { unifiedTabs, representedTabs }
  }
  return {
    /** Whether an input the last `record` read may have changed. */
    stale(state: AppState): boolean {
      if (!recorded) {
        return true
      }
      const { unifiedTabs, representedTabs } = syncWorkspaceState(state)
      if (
        prevRepresentedTabs !== representedTabs ||
        prevUnifiedTabs !== unifiedTabs ||
        prevOwnerHostId !== workspaceOwner?.hostId ||
        prevOwnerEnvId !== workspaceOwner?.worktree.runtimeOwnerEnvironmentId ||
        prevOwnerWorktreeHostId !== workspaceOwner?.worktree.hostId
      ) {
        return true
      }
      const nextSessionOwnerInputs = needsWorkspaceOwner
        ? structuredAgentSessionOwnerInputs(state)
        : null
      if (
        (nextSessionOwnerInputs === null) !== (prevSessionOwnerInputs === null) ||
        (nextSessionOwnerInputs !== null &&
          prevSessionOwnerInputs !== null &&
          !sameInputs(nextSessionOwnerInputs, prevSessionOwnerInputs))
      ) {
        return true
      }
      if (
        recordChangeReaches(state.terminalLayoutsByTabId, layouts, readTab) ||
        recordChangeReaches(state.ptyIdsByTabId, ptys, readTab)
      ) {
        return true
      }
      // Writes that missed these tabs are settled, so later reads walk only newer changes.
      layouts = state.terminalLayoutsByTabId
      ptys = state.ptyIdsByTabId
      return false
    },
    /** Notes what attributing `rows` reads, then returns the row predicate. */
    record(state: AppState, rows: readonly (DashboardAgentRow | undefined)[]) {
      const { unifiedTabs, representedTabs } = syncWorkspaceState(state)
      recorded = true
      prevRepresentedTabs = representedTabs
      prevUnifiedTabs = unifiedTabs
      prevOwnerHostId = workspaceOwner?.hostId
      prevOwnerEnvId = workspaceOwner?.worktree.runtimeOwnerEnvironmentId
      prevOwnerWorktreeHostId = workspaceOwner?.worktree.hostId
      prevSessionOwnerInputs = needsWorkspaceOwner ? structuredAgentSessionOwnerInputs(state) : null
      layouts = state.terminalLayoutsByTabId
      ptys = state.ptyIdsByTabId
      let nextTabIds: Set<string> | undefined
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]
        const tabId = row && parsePaneKey(row.activationPaneKey ?? row.paneKey)?.tabId
        if (tabId) {
          ;(nextTabIds ??= new Set<string>()).add(tabId)
        }
      }
      tabIds = nextTabIds ?? EMPTY_TAB_IDS
      const owner = workspaceOwner
      let stampedHosts: Map<string, ExecutionHostId | undefined> | undefined
      if (unifiedTabs) {
        for (let i = 0; i < unifiedTabs.length; i += 1) {
          const tab = unifiedTabs[i]
          if (tab.contentType === 'terminal') {
            ;(stampedHosts ??= new Map()).set(tab.entityId, tab.executionHostId)
          }
        }
      }
      const resolvedStampedHosts = stampedHosts ?? EMPTY_STAMPED_HOSTS
      return (row: DashboardAgentRow): boolean =>
        rowBelongsToHost(state, row, hostId, owner, resolvedStampedHosts)
    }
  }
}
