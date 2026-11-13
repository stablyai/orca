import type { AppState } from '@/store/types'
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
import { readRecordChanges } from '@/store/keyed-record-change-reads'
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

/** The tab ids and status pane keys this workspace's inputs read from the shared keyed maps. */
type WorkspaceUnreadKeys = { tabIds: Set<string>; paneKeys: Set<string> }

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
    if (keys) {
      keys.tabIds.add(tab.id)
      keys.paneKeys.add(paneKey)
      completionKeys.forEach((key) => keys.paneKeys.add(key))
    }
    inputs.push(
      state.unreadTerminalTabs[tab.id],
      completions.get(tab.id),
      // Host resolution for this tab: its layout, pty ids, and status entry.
      state.terminalLayoutsByTabId[tab.id],
      state.ptyIdsByTabId[tab.id],
      state.agentStatusByPaneKey[paneKey],
      ...completionKeys.map((key) => state.agentStatusByPaneKey[key])
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

/** Whether a map's writes may reach one of `reaches`' keys; unannotated writes always may. */
function keyedChangeReaches(
  next: Readonly<Record<string, unknown>>,
  previous: Readonly<Record<string, unknown>>,
  reaches: (key: string) => boolean
): boolean {
  const changes = readRecordChanges(next, previous)
  if (!changes) {
    return false
  }
  if (changes.kind !== 'addressed') {
    return true
  }
  for (const key of changes.keys) {
    if (reaches(key)) {
      return true
    }
  }
  return false
}

function sharedChangeReaches(
  next: SharedKeyedSources,
  previous: SharedKeyedSources,
  keys: WorkspaceUnreadKeys
): boolean {
  const byTab = (key: string): boolean => keys.tabIds.has(key)
  const byPane = (key: string): boolean => keys.paneKeys.has(key)
  // A new completion on one of this workspace's tabs adds a status key it will read.
  const byCompletionTab = (key: string): boolean => {
    const tabId = paneKeyTabId(key)
    return tabId !== null && keys.tabIds.has(tabId)
  }
  return (
    keyedChangeReaches(next.unreadTerminalTabs, previous.unreadTerminalTabs, byTab) ||
    keyedChangeReaches(next.terminalLayoutsByTabId, previous.terminalLayoutsByTabId, byTab) ||
    keyedChangeReaches(next.ptyIdsByTabId, previous.ptyIdsByTabId, byTab) ||
    keyedChangeReaches(
      next.unreadAgentCompletionPanes,
      previous.unreadAgentCompletionPanes,
      byCompletionTab
    ) ||
    keyedChangeReaches(next.agentStatusByPaneKey, previous.agentStatusByPaneKey, byPane)
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
  let keys: WorkspaceUnreadKeys = { tabIds: new Set(), paneKeys: new Set() }
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
    if (ownSourcesSame && shared && !sharedChangeReaches(nextShared, shared, keys)) {
      shared = nextShared
      return unread
    }
    sources = nextSources
    shared = nextShared
    const nextKeys: WorkspaceUnreadKeys = { tabIds: new Set(), paneKeys: new Set() }
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
