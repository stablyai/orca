import { isTerminalLeafId, makePaneKey } from '../../../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../../../shared/structured-agent-session-projection'
import { collectLeafIds } from '../../../../../shared/terminal-pane-layout-tree'
import type { AppState } from '../../types'
import type { WorkspaceAttentionGet, WorkspaceAttentionSet } from './workspace-attention-contract'
import { settleWorkspaceUnreadFlag } from './workspace-unread-flag'
import { paneKeyTabId, workspaceMarkerTabs } from './workspace-live-markers'

/** The state a marker removal is diffed against; any earlier `get()` satisfies it. */
export type AttentionRemovalSnapshot = Pick<
  AppState,
  | 'unreadTerminalTabs'
  | 'unreadTerminalPanes'
  | 'unreadAgentCompletionPanes'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'terminalLayoutsByTabId'
>

type MarkerKey = 'unreadTerminalTabs' | 'unreadTerminalPanes' | 'unreadAgentCompletionPanes'

export type RemovedAttention = {
  /** Workspaces that owned a removed marker, resolved in the snapshot (a closed tab is gone after). */
  workspaceIds: Set<string>
  /** Pane keys whose OS notifications the removal reads. */
  paneKeys: Set<string>
}

export function sameMarkers(
  before: Pick<AppState, MarkerKey>,
  after: Pick<AppState, MarkerKey>
): boolean {
  return (
    before.unreadTerminalTabs === after.unreadTerminalTabs &&
    before.unreadTerminalPanes === after.unreadTerminalPanes &&
    before.unreadAgentCompletionPanes === after.unreadAgentCompletionPanes
  )
}

function findTabOwner(
  state: AttentionRemovalSnapshot,
  tabId: string
): { workspaceId: string; structuredPaneKey: string | null } | null {
  const workspaceIds = new Set([
    ...Object.keys(state.tabsByWorktree),
    ...Object.keys(state.unifiedTabsByWorktree)
  ])
  for (const workspaceId of workspaceIds) {
    const tab = workspaceMarkerTabs(state, workspaceId).find((candidate) => candidate.id === tabId)
    if (tab) {
      return {
        workspaceId,
        structuredPaneKey:
          tab.sessionId === null ? null : structuredAgentSessionPaneKey(tab.id, tab.sessionId)
      }
    }
  }
  return null
}

function removedKeys(
  before: AttentionRemovalSnapshot,
  after: AttentionRemovalSnapshot,
  record: MarkerKey
): string[] {
  const next = after[record]
  return before[record] === next ? [] : Object.keys(before[record]).filter((key) => !next[key])
}

/** Markers present in `before` and gone in `after`; null when no marker record changed. */
export function collectRemovedAttention(
  before: AttentionRemovalSnapshot,
  after: AttentionRemovalSnapshot
): RemovedAttention | null {
  if (sameMarkers(before, after)) {
    return null
  }
  const removed: RemovedAttention = { workspaceIds: new Set(), paneKeys: new Set() }
  for (const tabId of removedKeys(before, after, 'unreadTerminalTabs')) {
    const owner = findTabOwner(before, tabId)
    if (!owner) {
      continue
    }
    removed.workspaceIds.add(owner.workspaceId)
    // Why every leaf: a tab-level bell has no pane marker naming the pane that rang.
    if (owner.structuredPaneKey) {
      removed.paneKeys.add(owner.structuredPaneKey)
    }
    for (const leafId of collectLeafIds(before.terminalLayoutsByTabId[tabId]?.root)) {
      if (isTerminalLeafId(leafId)) {
        removed.paneKeys.add(makePaneKey(tabId, leafId))
      }
    }
  }
  for (const paneKey of [
    ...removedKeys(before, after, 'unreadTerminalPanes'),
    ...removedKeys(before, after, 'unreadAgentCompletionPanes')
  ]) {
    removed.paneKeys.add(paneKey)
    const tabId = paneKeyTabId(paneKey)
    const owner = tabId === null ? null : findTabOwner(before, tabId)
    if (owner) {
      removed.workspaceIds.add(owner.workspaceId)
    }
  }
  return removed.paneKeys.size > 0 || removed.workspaceIds.size > 0 ? removed : null
}

/** One dismiss per operation; main retires each pane's Notification Center thread and announced ids. */
export function dismissReadNotifications(paneKeys: ReadonlySet<string>): void {
  if (paneKeys.size === 0 || typeof window === 'undefined') {
    return
  }
  void window.api?.notifications?.dismiss?.([], [...paneKeys])?.catch(() => {})
}

/** After marker-removing updates, settle affected workspace flags and dismiss pane notifications; no marker removal leaves manual unread intact. */
export function settleAttentionRemovedBy(
  set: WorkspaceAttentionSet,
  get: WorkspaceAttentionGet,
  remove: () => void,
  options?: {
    settleFlags?: boolean
    /** Where the tabs were before a removal main's frame already made. */
    tabsBefore?: Pick<
      AttentionRemovalSnapshot,
      'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
    >
  }
): void {
  const before = { ...get(), ...options?.tabsBefore }
  remove()
  const removed = collectRemovedAttention(before, get())
  if (!removed) {
    return
  }
  if (options?.settleFlags !== false) {
    for (const workspaceId of removed.workspaceIds) {
      settleWorkspaceUnreadFlag(set, get, workspaceId)
    }
  }
  dismissReadNotifications(removed.paneKeys)
}
