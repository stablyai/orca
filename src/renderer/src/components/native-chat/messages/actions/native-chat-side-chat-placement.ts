import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findSiblingGroupId } from '../../../../../../shared/workspace-layout/tab-groups/tab-group-layout-tree'
import { findStructuredLaunchTab } from '@/lib/agent-session/launch/structured-agent-session-launch-surface'
import { afterPendingTab } from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { requestNativeChatComposerFocus } from '../../composer/focus/native-chat-composer-focus-intent'
import { moveTabToGroup, moveTabToNewPaneColumn } from '../../../tab-bar/tab-move-to-pane-column'
import type { TabDropCompletion } from '../../../tab-group/tab-group-layout-owner-commands'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

// Moving a late tab would yank a pane the user may already be reading.
const SIDE_CHAT_MOVE_MS = 5_000
const SIDE_CHAT_WATCH_MS = 60_000

type SideChat = { sessionId: string; executionHostId: ExecutionHostId }
type SelectionState = Pick<AppState, 'activeGroupIdByWorktree' | 'groupsByWorktree'>

/** One `/btw` request's claim on the screen, from Send until its side chat is placed. */
export type NativeChatSideChatPlacement = {
  /** The side chat to place once its tab is drawn; undefined when there is nothing to place. */
  settle: (chat: SideChat | undefined) => void
}

/** Starts at Send: any other selection in the workspace, or leaving it, retires the claim for good,
 *  and the side chat then stays in the background. Once drawn, it is moved beside its source as
 *  dragging it there would, then selected and focused where the move lands; a refused move leaves it
 *  selected where Fork puts it. The claim holds until then, however long main takes to draw the move. */
export function beginNativeChatSideChatPlacement(
  worktreeId: string,
  sourceTabId: string
): NativeChatSideChatPlacement {
  const initial = useAppStore.getState()
  const before = selectionOf(initial, worktreeId, undefined, undefined)
  const activeWorktreeId = initial.activeWorktreeId
  let chat: SideChat | undefined
  let settledAt = 0
  let lookingUp = false
  // The side chat's tab once found, and, while main draws its move, the pane it is leaving.
  let forkTabId: string | undefined
  let movingFrom: string | undefined
  let retired = false

  const moving = (): Moving | undefined =>
    forkTabId && movingFrom ? { forkTabId, from: movingFrom } : undefined
  const retire = (): void => {
    if (!retired) {
      retired = true
      unsubscribe()
      clearTimeout(expiry)
    }
  }
  /** Select and focus the side chat where it is now, if the claim and the tab still exist. */
  const finish = (): void => {
    if (retired || !forkTabId) {
      return
    }
    const tabId = forkTabId
    // Our own selection below is not the user's.
    retire()
    const state = useAppStore.getState()
    if (!state.unifiedTabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)) {
      return
    }
    state.activateTab(tabId, { worktreeId })
    // Typing goes to the side chat once its composer shows.
    requestNativeChatComposerFocus(tabId)
  }
  const completion: TabDropCompletion = {
    refused: finish,
    moveHere: (move) => {
      if (!retired) {
        move()
        finish()
      }
    }
  }
  const place = (tabId: string): void => {
    if (retired) {
      return
    }
    forkTabId = tabId
    const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
    const fork = tabs.find((tab) => tab.id === tabId)
    const sourceGroupId = tabs.find((tab) => tab.id === sourceTabId)?.groupId
    // Already in another pane, or the source is gone: where it is now is beside enough.
    if (
      !fork ||
      !sourceGroupId ||
      fork.groupId !== sourceGroupId ||
      Date.now() - settledAt > SIDE_CHAT_MOVE_MS
    ) {
      finish()
      return
    }
    // From here the move's own changes are the request's, whether this window draws them now or
    // main's frame does later; an 'owner' move finishes once drawn, or when main refuses.
    movingFrom = sourceGroupId
    if (moveBeside(tabId, sourceGroupId) !== 'owner') {
      finish()
    }
  }
  const moveBeside = (tabId: string, sourceGroupId: string): 'owner' | 'moved' | false => {
    const layout = useAppStore.getState().layoutByWorktree[worktreeId]
    const sibling = layout ? findSiblingGroupId(layout, sourceGroupId) : null
    return sibling
      ? moveTabToGroup({ worktreeId, unifiedTabId: tabId, groupId: sibling }, undefined, completion)
      : moveTabToNewPaneColumn({
          worktreeId,
          unifiedTabId: tabId,
          groupId: sourceGroupId,
          direction: 'right',
          completion
        })
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
        selectionOf(state, worktreeId, moving(), before).key !== before.key)
    ) {
      retire()
      return
    }
    const tabs = state.unifiedTabsByWorktree[worktreeId]
    if (tabs === previous.unifiedTabsByWorktree[worktreeId]) {
      return
    }
    if (lookingUp) {
      lookUp()
    } else if (
      movingFrom &&
      tabs?.some((tab) => tab.id === forkTabId && tab.groupId !== movingFrom)
    ) {
      finish()
    }
  }
  const unsubscribe = useAppStore.subscribe(onChange)
  let expiry: ReturnType<typeof setTimeout> | undefined
  return {
    settle: (next) => {
      if (retired || chat || !next) {
        retire()
        return
      }
      chat = next
      settledAt = Date.now()
      // However long the fork took to open, its tab gets the same time to be drawn and moved.
      // Main never drew or answered its move: select it where Fork put it.
      expiry = setTimeout(() => (movingFrom ? finish() : retire()), SIDE_CHAT_WATCH_MS)
      lookingUp = true
      lookUp()
    }
  }
}

type Selection = {
  key: string
  activeGroupId: string | undefined
  activeTabByGroup: ReadonlyMap<string, string | null>
}

/** The side chat on its way out of `from`, while main draws its move. */
type Moving = { forkTabId: string; from: string }

/** The workspace's selection (its active pane and each pane's active tab). While main moves the side
 *  chat, what that move changes reads as it was at Send: a new pane holding only the side chat, or
 *  another pane showing it. Selecting it in the pane it is leaving is still the user's. */
function selectionOf(
  state: SelectionState,
  worktreeId: string,
  moving: Moving | undefined,
  before: Selection | undefined
): Selection {
  const shownByMove = (group: { id: string; activeTabId: string | null }): boolean =>
    moving !== undefined && group.id !== moving.from && group.activeTabId === moving.forkTabId
  const groups = (state.groupsByWorktree[worktreeId] ?? []).filter(
    (group) =>
      before?.activeTabByGroup.has(group.id) !== false ||
      !(
        shownByMove(group) &&
        group.tabOrder.length === 1 &&
        group.tabOrder[0] === moving?.forkTabId
      )
  )
  const activeTabByGroup = new Map(
    groups.map((group) => [
      group.id,
      shownByMove(group)
        ? (before?.activeTabByGroup.get(group.id) ?? null)
        : (group.activeTabId ?? null)
    ])
  )
  const active = state.activeGroupIdByWorktree[worktreeId]
  const activeGroup = (state.groupsByWorktree[worktreeId] ?? []).find(
    (group) => group.id === active
  )
  const activeGroupId = activeGroup && shownByMove(activeGroup) ? before?.activeGroupId : active
  const tabs = [...activeTabByGroup].map(([id, tab]) => `${id}:${tab ?? ''}`)
  return { key: `${activeGroupId ?? ''}|${tabs.join(',')}`, activeGroupId, activeTabByGroup }
}
