import type { Tab, TabGroup } from '../../../../shared/types'
import type { AppState } from '../../store/types'
import { reconcileTabOrder } from './reconcile-order'

export type VisibleTabRef = {
  type: 'terminal' | 'editor' | 'browser' | 'notes'
  id: string
  tabId?: string
}

/**
 * Compute the visible tab-strip order for a single group.
 *
 * Why: keyboard navigation (Cmd/Ctrl+Shift+[ / ]) and the IPC switch-tab
 * shortcut must walk tabs in the same order the TabBar renders them. The
 * TabBar derives its order from `group.tabOrder` (the canonical split-group
 * state, updated by drag/drop via `reorderUnifiedTabs`). Reading from the
 * legacy `tabBarOrderByWorktree` drifts out of sync because that store is
 * only written when tabs are created/closed — drag-reordering updates
 * `group.tabOrder` but not the legacy flat order, which surfaces as
 * keyboard nav cycling tabs in a stale sequence (e.g. 3 → 1 → 2 instead of
 * 3 → 2 → 1). This helper returns the exact ids TabBar uses, with a dual-id
 * contract for active-group entries: `id` always carries the backing
 * entity/file id used by legacy activation APIs, while `tabId` preserves the
 * unified tab id for exact split-group selection. That keeps both code paths
 * on the same order without collapsing the identifier domains.
 *
 * Note: TabBar's reconciler appends entities present in state but missing
 * from `group.tabOrder` (an invariant-repair fallback). This helper
 * intentionally does not mirror that append — appending silently would
 * reintroduce the class of order-drift this change fixes. In practice
 * `group.tabOrder` is kept in sync on tab create/close, so the divergence
 * only matters during hydration races and is preferable to cycling tabs
 * in a phantom order.
 *
 * Scope is intentionally per-group: with split layouts each group has its
 * own tab strip, and users expect the shortcut to cycle within the strip
 * they're looking at. Tabs that belong to the group but lack a matching
 * entity (e.g. terminal-runtime tab still being hydrated, or an editor
 * whose file has been closed) are skipped so navigation never lands on a
 * phantom tab.
 */
export function getGroupVisibleTabOrder(
  group: TabGroup,
  groupTabs: readonly Tab[],
  terminalEntityIds: ReadonlySet<string>,
  editorEntityIds: ReadonlySet<string>,
  browserEntityIds: ReadonlySet<string>
): VisibleTabRef[] {
  const tabsById = new Map(groupTabs.map((t) => [t.id, t]))
  const result: VisibleTabRef[] = []
  // Dedupe per category: terminal/browser key by entityId (multiple tabs
  // can theoretically point at the same runtime entity), editor keys by
  // unified tab id. Keeping the keyspaces separate avoids a cross-type
  // collision from dropping a legitimate tab.
  const seenTerminals = new Set<string>()
  const seenBrowsers = new Set<string>()
  const seenEditors = new Set<string>()
  const seenNotes = new Set<string>()
  for (const unifiedId of group.tabOrder) {
    const tab = tabsById.get(unifiedId)
    if (!tab) {
      continue
    }
    if (tab.contentType === 'terminal') {
      if (!terminalEntityIds.has(tab.entityId) || seenTerminals.has(tab.entityId)) {
        continue
      }
      seenTerminals.add(tab.entityId)
      result.push({ type: 'terminal', id: tab.entityId, tabId: tab.id })
    } else if (tab.contentType === 'browser') {
      if (!browserEntityIds.has(tab.entityId) || seenBrowsers.has(tab.entityId)) {
        continue
      }
      seenBrowsers.add(tab.entityId)
      result.push({ type: 'browser', id: tab.entityId, tabId: tab.id })
    } else if (tab.contentType === 'notes') {
      if (seenNotes.has(tab.id)) {
        continue
      }
      seenNotes.add(tab.id)
      result.push({ type: 'notes', id: tab.id, tabId: tab.id })
    } else {
      if (!editorEntityIds.has(tab.entityId) || seenEditors.has(tab.id)) {
        continue
      }
      seenEditors.add(tab.id)
      result.push({ type: 'editor', id: tab.entityId, tabId: tab.id })
    }
  }
  return result
}

/**
 * Resolve the visible tab order the active surface is showing, for keyboard
 * navigation.
 *
 * Prefers the active group's `group.tabOrder` so drag-reordered tabs cycle
 * in the order the user sees. Falls back to the legacy
 * `tabBarOrderByWorktree` path when no active group exists yet — this covers
 * sessions restored before the split-group model hydrated and the
 * pre-layout titlebar TabBar fallback rendered by Terminal.tsx. The fallback
 * still drifts for drag-reorders (the legacy store never learns about
 * them), but worktrees without a group cannot have split-aware drag in the
 * first place, so in practice only the active-group path matters once
 * layouts are established.
 */
export function getActiveTabNavOrder(
  state: Pick<
    AppState,
    | 'activeGroupIdByWorktree'
    | 'groupsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'tabBarOrderByWorktree'
    | 'tabsByWorktree'
    | 'openFiles'
    | 'browserTabsByWorktree'
  >,
  worktreeId: string
): VisibleTabRef[] {
  const terminalIds = (state.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds = state.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds = (state.browserTabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const notesIds = (state.unifiedTabsByWorktree[worktreeId] ?? [])
    .filter((tab) => tab.contentType === 'notes')
    .map((tab) => tab.id)

  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const group = activeGroupId
    ? (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === activeGroupId)
    : undefined

  if (group) {
    const groupTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
      (tab) => tab.groupId === group.id
    )
    return getGroupVisibleTabOrder(
      group,
      groupTabs,
      new Set(terminalIds),
      new Set(editorIds),
      new Set(browserIds)
    )
  }

  // Legacy fallback: no split-group layout yet for this worktree.
  const visibleIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    terminalIds,
    editorIds,
    browserIds,
    notesIds
  )
  const terminalIdSet = new Set(terminalIds)
  const editorIdSet = new Set(editorIds)
  const browserIdSet = new Set(browserIds)
  const notesIdSet = new Set(notesIds)
  const result: VisibleTabRef[] = []
  for (const id of visibleIds) {
    if (terminalIdSet.has(id)) {
      result.push({ type: 'terminal', id })
    } else if (editorIdSet.has(id)) {
      result.push({ type: 'editor', id })
    } else if (browserIdSet.has(id)) {
      result.push({ type: 'browser', id })
    } else if (notesIdSet.has(id)) {
      result.push({ type: 'notes', id, tabId: id })
    }
  }
  return result
}
