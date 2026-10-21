// Editor tab closes in a layout-owner build: main closes the tab and its frame drops it; the window
// changes no tab first, so a close main refuses leaves the tab. Once the frame is in, the group
// shows the tab today's close picks (its previous one). Waiters on the tab learn the outcome.

import type { Tab } from '../../../../../../shared/tab-types'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import {
  afterPendingTabs,
  beginPendingTab,
  hasPendingEntityTab,
  isTabClosePending,
  markPendingCloseCleansFile,
  pendingCloseCleansFile
} from '@/runtime/layout-owner-pending-tabs'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { pickNextActiveTab } from '../../tab-group-state'
import { isEditorTabContentType } from './editor-tab-content-type'

/**
 * Once main's frame dropped the closed tab, its group shows the tab today's close picks (one
 * picked before that is itself gone falls back to the group's history), and the workspace's
 * surface follows its active group. Nothing while the tab still shows.
 */
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

/**
 * Sends an editor tab's close; false when it is no editor tab or main is not asked (a paired
 * server owns the workspace's layout), and the caller closes it as today. `closeHere` is today's
 * close, for a twin main may route to a paired server.
 */
export function closeEditorTabThroughLayoutOwner(
  get: () => AppState,
  tab: Pick<Tab, 'id' | 'entityId' | 'worktreeId' | 'groupId' | 'contentType'>,
  /** The tab today's close would show next in the group, picked before the close. */
  nextActiveTabId: string | null,
  closeHere: () => void
): boolean {
  if (!isEditorTabContentType(tab.contentType)) {
    return false
  }
  // Its waiters (closeFile's cleanup) stay on the close already in flight.
  if (isTabClosePending(tab.id)) {
    return true
  }
  const settle = beginPendingTab(tab.id, tab.worktreeId, tab.entityId, { kind: 'close' })
  const sent = sendLayoutApply(
    get(),
    tab.worktreeId,
    { type: 'closeTabs', tabIds: [tab.id] },
    {
      apply: (result) => {
        const closed = result.closed?.includes(tab.id) ?? true
        // Waiters first: a closeFile's content cleanup must not undo the selection.
        settle(closed ? tab.id : null)
        if (closed) {
          selectAfterClose(get, tab, nextActiveTabId)
        }
      },
      asToday: () => {
        let closedId: string | null = null
        try {
          closeHere()
          closedId = tab.id
        } finally {
          settle(closedId)
        }
      },
      refused: () => settle(null)
    }
  )
  if (!sent) {
    settle(null)
  }
  return sent
}

/**
 * closeFile's tabs: main closes each, and the file's content goes once every close is in, unless
 * one was refused or the file reopened meanwhile. A repeat close joins the one in flight; so does
 * the file's cleanup, unless that close (a bulk close's) carries none.
 */
export function closeFileTabsThroughLayoutOwner(
  get: () => AppState,
  tabIds: readonly string[],
  file: { worktreeId: string; fileId: string },
  cleanUp: () => void
): void {
  // An earlier closeFile's cleanup waits on these closes: it cleans the file up, once.
  if (tabIds.every(isTabClosePending) && tabIds.some(pendingCloseCleansFile)) {
    return
  }
  for (const tabId of tabIds) {
    if (!isTabClosePending(tabId)) {
      get().closeUnifiedTab(tabId)
    }
  }
  tabIds.forEach(markPendingCloseCleansFile)
  afterPendingTabs(tabIds, (outcomes) => {
    const reopened =
      hasPendingEntityTab(file.worktreeId, file.fileId) ||
      (get().unifiedTabsByWorktree[file.worktreeId] ?? []).some(
        (tab) => tab.entityId === file.fileId
      )
    if (outcomes.every((outcome) => outcome !== null) && !reopened) {
      cleanUp()
    }
  })
}

/** Editor tabs of a workspace whose file record the window just dropped: main closes them. */
export function closeDroppedEditorFileTabsThroughLayoutOwner(
  state: AppState,
  filesBefore: readonly Pick<OpenFile, 'id' | 'worktreeId'>[],
  worktreeId: string
): void {
  const kept = new Set(state.openFiles.map((file) => file.id))
  const dropped = new Set(
    filesBefore.flatMap((file) =>
      file.worktreeId === worktreeId && !kept.has(file.id) ? [file.id] : []
    )
  )
  const keep = (): void => {}
  for (const tab of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (dropped.has(tab.entityId) && isEditorTabContentType(tab.contentType)) {
      sendLayoutApply(
        state,
        worktreeId,
        { type: 'closeTabs', tabIds: [tab.id] },
        { apply: keep, asToday: keep }
      )
    }
  }
}
