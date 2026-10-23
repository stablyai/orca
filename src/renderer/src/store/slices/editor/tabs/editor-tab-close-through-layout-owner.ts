// Editor tabs whose file record the window dropped, in a layout-owner build: main closes them.
// A single tab's close goes through `closeContentTabThroughLayoutOwner`.

import { sendLayoutApply } from '@/runtime/layout-apply-send'
import {
  afterPendingTabs,
  hasPendingEntityTab,
  isTabClosePending,
  markPendingCloseCleansFile,
  pendingCloseCleansFile
} from '@/runtime/layout-owner-pending-tabs'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import { isEditorTabContentType } from './editor-tab-content-type'

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
