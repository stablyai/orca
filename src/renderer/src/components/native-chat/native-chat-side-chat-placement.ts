import { useAppStore } from '@/store'
import { findSiblingGroupId } from '@/store/slices/tabs'
import { tabSelectionKey } from '@/store/slices/tabs/moved-tab-selection'
import { findStructuredLaunchTab } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import { afterPendingTab } from '@/runtime/layout-owner-pending-tabs'
import {
  canMoveTabToNewPaneColumn,
  moveTabToGroup,
  moveTabToNewPaneColumn
} from '../tab-bar/tab-move-to-pane-column'
import type { ExecutionHostId } from '../../../../shared/execution-host'

// Moving a late tab would yank a pane the user may already be reading.
const SIDE_CHAT_MOVE_MS = 5_000
const SIDE_CHAT_WATCH_MS = 60_000

/** What the user was looking at when they sent `/btw`; the side chat may take focus only while it holds. */
export function captureNativeChatSideChatSelection(worktreeId: string): string {
  return tabSelectionKey(useAppStore.getState(), worktreeId)
}

/** Once the side chat's tab is drawn, select it and move it beside its source, as the user would by
 *  dragging it there. A refused move leaves it selected where Fork puts it. */
export function placeNativeChatSideChat(args: {
  worktreeId: string
  sourceTabId: string
  selection: string
  chat: { sessionId: string; executionHostId: ExecutionHostId }
}): void {
  const { worktreeId, sourceTabId, selection } = args
  const startedAt = Date.now()
  const place = (tabId: string): void => {
    const state = useAppStore.getState()
    // The user selected another tab or pane meanwhile: leave the side chat in the background.
    if (
      Date.now() - startedAt > SIDE_CHAT_WATCH_MS ||
      tabSelectionKey(state, worktreeId) !== selection
    ) {
      return
    }
    state.activateTab(tabId, { worktreeId })
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const fork = tabs.find((tab) => tab.id === tabId)
    const sourceGroupId = tabs.find((tab) => tab.id === sourceTabId)?.groupId
    // Already in another pane, or the source is gone: where it is now is beside enough.
    if (
      !fork ||
      !sourceGroupId ||
      fork.groupId !== sourceGroupId ||
      Date.now() - startedAt > SIDE_CHAT_MOVE_MS
    ) {
      return
    }
    const layout = state.layoutByWorktree[worktreeId]
    const sibling = layout ? findSiblingGroupId(layout, sourceGroupId) : null
    if (sibling) {
      moveTabToGroup({ worktreeId, unifiedTabId: tabId, groupId: sibling })
    } else if (canMoveTabToNewPaneColumn(tabId, sourceGroupId)) {
      moveTabToNewPaneColumn({ unifiedTabId: tabId, groupId: sourceGroupId, direction: 'right' })
    }
  }
  let watching = true
  const stop = (): void => {
    watching = false
    unsubscribe()
    clearTimeout(expiry)
  }
  const check = (): void => {
    if (!watching) {
      return
    }
    const tab = findStructuredLaunchTab({ worktreeId, ...args.chat })
    if (tab) {
      stop()
      // Main may still be drawing it; select and move the tab its frame shows.
      afterPendingTab(tab.id, (drawn) => {
        if (drawn) {
          place(drawn)
        }
      })
    } else if (tabSelectionKey(useAppStore.getState(), worktreeId) !== selection) {
      stop()
    }
  }
  // Only tab and selection changes can draw the side chat or end the watch.
  const unsubscribe = useAppStore.subscribe((state, previous) => {
    if (
      state.unifiedTabsByWorktree !== previous.unifiedTabsByWorktree ||
      state.groupsByWorktree !== previous.groupsByWorktree ||
      state.activeGroupIdByWorktree !== previous.activeGroupIdByWorktree
    ) {
      check()
    }
  })
  const expiry = setTimeout(stop, SIDE_CHAT_WATCH_MS)
  check()
}
