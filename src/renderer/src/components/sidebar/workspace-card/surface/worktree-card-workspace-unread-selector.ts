import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusProjection } from '@/store/slices/agent-status/agent-status-projection'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { structuredAgentSessionOwnerInputs } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { resolveQualifiedWorktreeExecutionOwner } from '@/lib/workspace/ownership/qualified-worktree-execution-owner'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  completionPaneKeysByTabId,
  paneKeyTabId,
  workspaceMarkerTabs
} from '@/store/slices/workspace-attention/workspace-live-markers'
import { recordChangeReaches } from '@/store/keyed-record-change-reads'
import { markerTabPaneKey } from '@/store/slices/workspace-attention/workspace-marker-host'
import {
  workspaceUnreadTarget,
  workspaceUnreadTargetsOutsideAgentRows,
  type SlotTarget
} from '../../worktree-card-slot-targets'

/**
 * Exactly what `workspaceUnreadTargetsOutsideAgentRows` reads for this workspace, so an agent
 * update, marker or layout change in another workspace does not re-resolve this card. O(tabs
 * in this workspace); completion markers come from the shared per-snapshot tab index.
 */
export function workspaceUnreadInputs(state: AppState, worktree: Worktree): unknown[] {
  return collectWorkspaceUnreadInputs(state, worktree)
}

/** The tab ids, and the status rows by pane, this workspace's inputs read from shared maps. */
type WorkspaceUnreadKeys = {
  tabIds: Set<string>
  statuses: Map<string, AgentStatusEntry | undefined>
  /** The workspace's projected row revision those statuses were read at. */
  revision: { projection: AgentStatusProjection | null; value: number }
}

function emptyUnreadKeys(): WorkspaceUnreadKeys {
  return { tabIds: new Set(), statuses: new Map(), revision: { projection: null, value: 0 } }
}

/** Whether one of this workspace's recorded status rows was replaced. */
function statusRowsReach(
  statuses: AppState['agentStatusByPaneKey'],
  worktreeId: string,
  keys: WorkspaceUnreadKeys
): boolean {
  const { projection } = statuses
  const revision = projection.revision(worktreeId)
  // Any row change in this workspace moves its revision, so other workspaces' writes skip the walk.
  if (keys.revision.projection === projection && keys.revision.value === revision) {
    return false
  }
  for (const [key, entry] of keys.statuses) {
    // Accepted rows are immutable per pane, so a changed read is a changed row identity.
    if (statuses.get(key) !== entry) {
      return true
    }
  }
  keys.revision = { projection, value: revision }
  return false
}

function collectWorkspaceUnreadInputs(
  state: AppState,
  worktree: Worktree,
  keys?: WorkspaceUnreadKeys
): unknown[] {
  const identity = composeWorktreeHostIdentity(worktree.hostId ?? 'local', worktree.id)
  const owner = resolveQualifiedWorktreeExecutionOwner(
    selectWorktreesByRepo(state),
    state.repos,
    worktree.id,
    worktree.hostId ?? 'local'
  )?.worktree
  if (keys) {
    keys.revision = {
      projection: state.agentStatusByPaneKey.projection,
      value: state.agentStatusByPaneKey.projection.revision(worktree.id)
    }
  }
  const inputs: unknown[] = [
    state.workspacesMarkedUnreadByUser[identity],
    state.tabsByWorktree[worktree.id],
    state.unifiedTabsByWorktree[worktree.id],
    owner?.hostId,
    owner?.runtimeOwnerEnvironmentId
  ]
  const completions = completionPaneKeysByTabId(state.unreadAgentCompletionPanes)
  let hasStructuredTab = false
  for (const tab of workspaceMarkerTabs(state, worktree.id)) {
    hasStructuredTab ||= tab.sessionId !== null
    const paneKey = markerTabPaneKey(state, tab)
    const completionKeys = completions.get(tab.id) ?? []
    const statuses = [paneKey, ...completionKeys].map((key) => {
      const entry = state.agentStatusByPaneKey.get(key)
      keys?.statuses.set(key, entry)
      return entry
    })
    keys?.tabIds.add(tab.id)
    inputs.push(
      state.unreadTerminalTabs[tab.id],
      completions.get(tab.id),
      // Host resolution for this tab: its layout, pty ids, and status entry.
      state.terminalLayoutsByTabId[tab.id],
      state.ptyIdsByTabId[tab.id],
      ...statuses
    )
  }
  if (hasStructuredTab) {
    // Chat ownership can fall back to workspace and runtime state when a tab has no stamped host.
    inputs.push(...structuredAgentSessionOwnerInputs(state))
  }
  return inputs
}

type SharedKeyedSources = Pick<
  AppState,
  | 'unreadTerminalTabs'
  | 'unreadAgentCompletionPanes'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'agentStatusByPaneKey'
>

function sharedKeyedSources(state: AppState): SharedKeyedSources {
  return {
    unreadTerminalTabs: state.unreadTerminalTabs,
    unreadAgentCompletionPanes: state.unreadAgentCompletionPanes,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    agentStatusByPaneKey: state.agentStatusByPaneKey
  }
}

function sharedChangeReaches(
  next: SharedKeyedSources,
  previous: SharedKeyedSources,
  worktreeId: string,
  keys: WorkspaceUnreadKeys
): boolean {
  const byTab = (key: string): boolean => keys.tabIds.has(key)
  // A new completion on one of this workspace's tabs adds a status key it will read.
  const byCompletionTab = (key: string): boolean => {
    const tabId = paneKeyTabId(key)
    return tabId !== null && keys.tabIds.has(tabId)
  }
  return (
    recordChangeReaches(next.unreadTerminalTabs, previous.unreadTerminalTabs, byTab) ||
    recordChangeReaches(next.terminalLayoutsByTabId, previous.terminalLayoutsByTabId, byTab) ||
    recordChangeReaches(next.ptyIdsByTabId, previous.ptyIdsByTabId, byTab) ||
    recordChangeReaches(
      next.unreadAgentCompletionPanes,
      previous.unreadAgentCompletionPanes,
      byCompletionTab
    ) ||
    (next.agentStatusByPaneKey !== previous.agentStatusByPaneKey &&
      statusRowsReach(next.agentStatusByPaneKey, worktreeId, keys))
  )
}

/** Whether the card's workspace unread has a source its visible agent rows don't already show. */
export function createWorkspaceUnreadSelector(
  worktree: Worktree,
  visibleAgents: readonly SlotTarget[]
) {
  const target = workspaceUnreadTarget(
    worktree.id,
    worktree.lastActivityAt || null,
    worktree.hostId ?? 'local'
  )
  const identity = composeWorktreeHostIdentity(worktree.hostId ?? 'local', worktree.id)
  let sources: readonly unknown[] = []
  let shared: SharedKeyedSources | null = null
  let keys = emptyUnreadKeys()
  let unifiedTabs: AppState['unifiedTabsByWorktree'][string] | undefined
  let hasStructuredTab = false
  let inputs: readonly unknown[] | null = null
  let unread = false
  return (state: AppState) => {
    if (!worktree.isUnread) {
      return false
    }
    const nextUnifiedTabs = state.unifiedTabsByWorktree[worktree.id]
    if (nextUnifiedTabs !== unifiedTabs) {
      unifiedTabs = nextUnifiedTabs
      hasStructuredTab = unifiedTabs?.some((tab) => tab.contentType === 'agent-session') ?? false
    }
    // Read whole; the shared tab- and pane-keyed maps are gated by changed key below.
    const nextSources = [
      state.workspacesMarkedUnreadByUser[identity],
      state.tabsByWorktree[worktree.id],
      unifiedTabs,
      selectWorktreesByRepo(state),
      state.repos,
      ...(hasStructuredTab ? structuredAgentSessionOwnerInputs(state) : [])
    ]
    const nextShared = sharedKeyedSources(state)
    const ownSourcesSame =
      sources.length === nextSources.length &&
      nextSources.every((value, index) => value === sources[index])
    // Why: every agent update replaces the status map. Only a write to this workspace's tabs or
    // panes can change its answer, so other writes skip the walk over its marker tabs.
    if (ownSourcesSame && shared && !sharedChangeReaches(nextShared, shared, worktree.id, keys)) {
      shared = nextShared
      return unread
    }
    sources = nextSources
    shared = nextShared
    const nextKeys = emptyUnreadKeys()
    const next = collectWorkspaceUnreadInputs(state, worktree, nextKeys)
    keys = nextKeys
    if (
      inputs === null ||
      next.length !== inputs.length ||
      !next.every((value, index) => value === inputs![index])
    ) {
      inputs = next
      unread = workspaceUnreadTargetsOutsideAgentRows(state, target, visibleAgents).length > 0
    }
    return unread
  }
}
