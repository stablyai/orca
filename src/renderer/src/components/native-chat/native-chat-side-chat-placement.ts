import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
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

type SideChat = { sessionId: string; executionHostId: ExecutionHostId }

/** One `/btw` request's claim on the screen, from Send until its side chat is placed. */
export type NativeChatSideChatPlacement = {
  /** The side chat to place once its tab is drawn; undefined when there is nothing to place. */
  settle: (chat: SideChat | undefined) => void
}

/** Starts at Send: any other selection in the workspace, or leaving it, retires the claim for good,
 *  and the side chat then stays in the background. Once drawn, it is selected and moved beside its
 *  source as dragging it there would; a refused move leaves it selected where Fork puts it. */
export function beginNativeChatSideChatPlacement(
  worktreeId: string,
  sourceTabId: string
): NativeChatSideChatPlacement {
  const initial = useAppStore.getState()
  const selection = tabSelectionKey(initial, worktreeId)
  const activeWorktreeId = initial.activeWorktreeId
  let chat: SideChat | undefined
  let settledAt = 0
  let lookingUp = false
  let retired = false

  const retire = (): void => {
    if (!retired) {
      retired = true
      unsubscribe()
      clearTimeout(expiry)
    }
  }
  const place = (tabId: string): void => {
    if (retired) {
      return
    }
    // Our own selection and move below are not the user's.
    retire()
    const state = useAppStore.getState()
    state.activateTab(tabId, { worktreeId })
    const tabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const fork = tabs.find((tab) => tab.id === tabId)
    const sourceGroupId = tabs.find((tab) => tab.id === sourceTabId)?.groupId
    // Already in another pane, or the source is gone: where it is now is beside enough.
    if (
      !fork ||
      !sourceGroupId ||
      fork.groupId !== sourceGroupId ||
      Date.now() - settledAt > SIDE_CHAT_MOVE_MS
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
  const lookUp = (): void => {
    const tab = chat && findStructuredLaunchTab({ worktreeId, ...chat })
    if (tab) {
      lookingUp = false
      // Main may still be drawing it; place the tab its frame shows.
      afterPendingTab(tab.id, (drawn) => (drawn ? place(drawn) : retire()))
    }
  }
  const onChange = (state: AppState, previous: AppState): void => {
    if (
      state.activeWorktreeId !== activeWorktreeId ||
      !state.groupsByWorktree[worktreeId] ||
      ((state.groupsByWorktree[worktreeId] !== previous.groupsByWorktree[worktreeId] ||
        state.activeGroupIdByWorktree[worktreeId] !==
          previous.activeGroupIdByWorktree[worktreeId]) &&
        tabSelectionKey(state, worktreeId) !== selection)
    ) {
      retire()
    } else if (
      lookingUp &&
      state.unifiedTabsByWorktree[worktreeId] !== previous.unifiedTabsByWorktree[worktreeId]
    ) {
      lookUp()
    }
  }
  const unsubscribe = useAppStore.subscribe(onChange)
  const expiry = setTimeout(retire, SIDE_CHAT_WATCH_MS)
  return {
    settle: (next) => {
      if (retired || chat || !next) {
        retire()
        return
      }
      chat = next
      settledAt = Date.now()
      lookingUp = true
      lookUp()
    }
  }
}
