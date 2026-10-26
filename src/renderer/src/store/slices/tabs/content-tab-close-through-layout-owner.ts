// Main decides content closes; wait for its frame before cleanup and selection, preserving refused tabs and notifying close waiters.

import type { Tab } from '../../../../../shared/tab-types'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import {
  afterPendingTab,
  beginPendingTab,
  isPendingTab,
  isTabClosePending
} from '@/runtime/layout-owner-pending-tabs'
import type { AppState } from '../../types'
import { pickNextActiveTab } from '../tab-group-state'
import { isEditorTabContentType } from '../editor/tabs/editor-tab-content-type'

/** Tab kinds whose close main decides; a terminal's goes through its own close. */
export function closesThroughLayoutOwner(contentType: Tab['contentType']): boolean {
  return (
    isEditorTabContentType(contentType) ||
    contentType === 'browser' ||
    contentType === 'agent-session' ||
    contentType === 'simulator'
  )
}

/** After main’s frame drops the tab, choose the preselected successor or group MRU fallback, then follow the active group’s surface. */
function selectAfterClose(
  get: () => AppState,
  tab: Pick<Tab, 'id' | 'worktreeId' | 'groupId'>,
  nextActiveTabId: string | null
): void {
  const state = get()
  const worktreeId = tab.worktreeId
  if ((state.unifiedTabsByWorktree[worktreeId] ?? []).some((entry) => entry.id === tab.id)) {
    return
  }
  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const group = state.groupsByWorktree[worktreeId]?.find((entry) => entry.id === tab.groupId)
  const next =
    group && nextActiveTabId && group.tabOrder.includes(nextActiveTabId)
      ? nextActiveTabId
      : group
        ? pickNextActiveTab(group.tabOrder, group.recentTabIds, tab.id)
        : null
  if (next && group?.activeTabId !== next) {
    state.activateTab(next, { worktreeId, preservePreview: true, recordFocus: false })
  }
  // Activation focuses the tab's group; the user's focused group stays, and shows its surface.
  if (activeGroupId) {
    get().focusGroup(worktreeId, activeGroupId)
  }
}

/** Tabs whose twin close main answered as today, while today's close runs. */
const closingAsToday = new Set<string>()

export type ContentTabClose = {
  /** The tab today's close would show next in the group, picked before the close. */
  nextActiveTabId: string | null
  /** Today's close, for a twin main may route to a paired server. */
  closeHere: () => void
  /** Why a browser tab closes: a cleanup close stays off main's reopen list. */
  recordClose?: 'user' | 'cleanup'
  /** The window's own cleanup once main's frame dropped the tab, before the selection moves. */
  closed?: () => void
  /** Lands an emptied active worktree on the welcome screen; true when it did. */
  landIfEmptied?: () => boolean
}

/** Return false for kinds/layouts main does not own, allowing caller-local close. */
export function closeContentTabThroughLayoutOwner(
  get: () => AppState,
  tab: Pick<Tab, 'id' | 'entityId' | 'worktreeId' | 'groupId' | 'contentType'>,
  close: ContentTabClose
): boolean {
  // Today's close of a twin's tab closes its tab-bar entry as today too.
  if (!closesThroughLayoutOwner(tab.contentType) || closingAsToday.has(tab.id)) {
    return false
  }
  // A repeat close joins the one in flight; its waiters (closeFile's cleanup) stay on it.
  if (isTabClosePending(tab.id)) {
    return true
  }
  // A close of a tab still opening goes once main answered the open.
  if (isPendingTab(tab.id)) {
    afterPendingTab(tab.id, () => {
      const drawn = get().unifiedTabsByWorktree[tab.worktreeId]?.find((e) => e.id === tab.id)
      if (drawn) {
        closeContentTabThroughLayoutOwner(get, drawn, close)
      }
    })
    return true
  }
  const settle = beginPendingTab(tab.id, tab.worktreeId, tab.entityId, { kind: 'close' })
  const dropped = (): void => {
    // Waiters first: a closeFile's content cleanup must not undo the selection.
    settle(tab.id)
    close.closed?.()
    if (!close.landIfEmptied?.()) {
      selectAfterClose(get, tab, close.nextActiveTabId)
    }
  }
  const closeAsToday = (): void => {
    closingAsToday.add(tab.id)
    let closedId: string | null = null
    try {
      close.closeHere()
      closedId = tab.id
    } finally {
      closingAsToday.delete(tab.id)
      settle(closedId)
    }
  }
  const sent = sendLayoutApply(
    get(),
    tab.worktreeId,
    {
      type: 'closeTabs',
      tabIds: [tab.id],
      ...(close.recordClose ? { recordClose: close.recordClose } : {})
    },
    {
      apply: (result) => {
        if (result.closed?.includes(tab.id) ?? true) {
          dropped()
        } else {
          settle(null)
        }
      },
      asToday: closeAsToday,
      // Treat missing held tabs/workspaces as already closed; never-held workspaces remain window-owned.
      refused: (code) => {
        const shows = get().unifiedTabsByWorktree[tab.worktreeId]?.some((e) => e.id === tab.id)
        if ((code === 'tab_not_found' || code === 'workspace_not_found') && !shows) {
          dropped()
        } else if (code === 'workspace_not_found') {
          closeAsToday()
        } else {
          settle(null)
        }
      }
    }
  )
  if (!sent) {
    settle(null)
  }
  return sent
}
