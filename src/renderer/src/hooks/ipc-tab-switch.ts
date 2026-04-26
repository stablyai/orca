import { useAppStore } from '../store'
import { getActiveTabNavOrder } from '@/components/tab-bar/group-tab-order'

/**
 * Handle Cmd/Ctrl+Tab direction switching across terminal, editor, and browser tabs.
 * Extracted from useIpcEvents to keep file size under the max-lines lint threshold.
 * Returns true if a tab switch occurred, false otherwise.
 */
export function handleSwitchTab(direction: number): boolean {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  if (!worktreeId) {
    return false
  }
  // Why: walk the active group's visible order so drag-reordered tabs cycle
  // in the sequence the user sees. See getActiveTabNavOrder for the stale
  // legacy-order bug this replaces.
  const allTabIds = getActiveTabNavOrder(store, worktreeId)
  if (allTabIds.length <= 1) {
    return false
  }
  const activeGroupId = store.activeGroupIdByWorktree[worktreeId]
  const group = activeGroupId
    ? (store.groupsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === activeGroupId)
    : undefined
  // Why: prefer the active group's unified tab id so split layouts disambiguate
  // which copy of a same-entity tab is focused. Match strictly against `tabId`
  // in that path; only fall back to backing-id matching when the group path
  // doesn't apply (no group, or its activeTabId isn't in the visible nav —
  // e.g. hydration races). Keeping the two domains in separate branches
  // prevents a backing id from colliding with an unrelated tab's `tabId`.
  const groupTabIdInNav =
    group?.activeTabId && allTabIds.some((entry) => entry.tabId === group.activeTabId)
      ? group.activeTabId
      : null
  let idx: number
  if (groupTabIdInNav) {
    idx = allTabIds.findIndex((t) => t.tabId === groupTabIdInNav)
  } else {
    const fallbackId =
      store.activeTabType === 'editor'
        ? store.activeFileId
        : store.activeTabType === 'browser'
          ? store.activeBrowserTabId
          : store.activeTabId
    idx = allTabIds.findIndex((t) => t.id === fallbackId)
  }
  const next = allTabIds[(idx + direction + allTabIds.length) % allTabIds.length]
  if (next.type === 'terminal') {
    store.setActiveTab(next.id)
    store.setActiveTabType('terminal')
  } else if (next.type === 'browser') {
    store.setActiveBrowserTab(next.id)
    store.setActiveTabType('browser')
  } else {
    // Why: `setActiveFile` targets the file entity (its implicit activateTab
    // picks the first matching tab in the active group); `activateTab(tabId)`
    // then disambiguates which split copy when the same file is open twice.
    store.setActiveFile(next.id)
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('editor')
  }
  return true
}

/**
 * Handle Ctrl+PageUp/PageDown switching across terminal tabs only.
 * Returns true if a terminal tab switch occurred, false otherwise.
 */
export function handleSwitchTerminalTab(direction: number): boolean {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  if (!worktreeId) {
    return false
  }
  // Why: reuse the same visible-order source as handleSwitchTab so drag-reordered
  // tabs still cycle in the sequence shown in the active tab strip.
  const terminalTabs = getActiveTabNavOrder(store, worktreeId).filter(
    (entry) => entry.type === 'terminal'
  )
  if (terminalTabs.length === 0) {
    return false
  }
  const currentId =
    store.activeTabType === 'editor'
      ? store.activeFileId
      : store.activeTabType === 'browser'
        ? store.activeBrowserTabId
        : store.activeTabId
  // Why: when an editor/browser tab is active, jump to the first terminal on
  // forward navigation instead of skipping to index 1.
  const idx = terminalTabs.findIndex((t) => t.id === currentId)
  // Why: only no-op when the sole terminal is already focused. With one terminal
  // and an editor/browser active, the chord must still jump to that terminal -
  // that is the whole point of the shortcut. The single-terminal-already-active
  // case is the only true no-op.
  if (terminalTabs.length === 1 && idx === 0) {
    return false
  }
  const currentIndex = idx === -1 && direction > 0 ? -1 : idx === -1 ? 0 : idx
  const next = terminalTabs[(currentIndex + direction + terminalTabs.length) % terminalTabs.length]
  // Why: skip the store writes when the target terminal is already the active
  // tab (e.g. single-terminal with that terminal focused but via a different
  // code path). Redundant setActiveTab calls trigger unnecessary subscriber
  // work in components that react to active-tab changes.
  if (next.id === store.activeTabId && store.activeTabType === 'terminal') {
    return false
  }
  store.setActiveTab(next.id)
  store.setActiveTabType('terminal')
  return true
}
