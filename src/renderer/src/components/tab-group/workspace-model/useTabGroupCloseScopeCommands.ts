import { keepWorkerPaneOnClose } from '../../tab-bar/worker-tab-user-close'
import { workerTabStripOrder } from '../../../../../shared/workspace-layout/tab-groups/worker-tab-strip-order'
import { selectWorkerTabPeekId } from '../../tab-bar/worker-tab-presentation'
import { useCallback } from 'react'
import { useAppStore } from '../../../store/index'
import { captureWorkspaceEmptiedReaction } from '../../../lib/workspace/tabs/close/workspace-emptied-reaction'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { useBulkTabCloseConfirmation } from '../../terminal/tab-lifecycle/use-bulk-tab-close-confirmation'
import type { BulkTabCloseScope } from '../../../../../shared/workspace-layout/tab-groups/bulk-tab-close-confirmation'
import { selectFoldedWorkerTabIds } from '../../tab-bar/worker-tab-folding'

export function useTabGroupCloseScopeCommands({
  groupId,
  worktreeId,
  closeItem,
  closeMany
}: {
  groupId: string
  worktreeId: string
  closeItem: (itemId: string, opts?: { skipEmptyCheck?: boolean }) => void
  closeMany: (itemIds: string[]) => void
}) {
  const closeEmptyGroup = useAppStore((state) => state.closeEmptyGroup)
  const confirmBulkClose = useBulkTabCloseConfirmation()
  const selectTabIds = useCallback(
    (scope: BulkTabCloseScope, itemId?: string): string[] => {
      const state = useAppStore.getState()
      const group = (state.groupsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === groupId
      )
      if (!group) {
        return []
      }
      // Folded worker tabs are not in the strip, so no strip-relative close reaches them.
      const folded = selectFoldedWorkerTabIds(state, worktreeId, groupId)
      const tabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
        (tab) => tab.groupId === groupId && !folded.has(tab.id)
      )
      if (scope === 'editors') {
        return tabs
          .filter((tab) => isEditorTabContentType(tab.contentType) && !tab.isPinned)
          .map((tab) => tab.id)
      }
      if (itemId === undefined || !tabs.some((tab) => tab.id === itemId)) {
        return []
      }
      if (scope === 'others') {
        return tabs.filter((tab) => tab.id !== itemId && !tab.isPinned).map((tab) => tab.id)
      }
      const stripOrder = workerTabStripOrder(
        group.tabOrder.filter((id) => !folded.has(id)),
        tabs,
        selectWorkerTabPeekId(state, worktreeId, groupId)
      )
      const index = stripOrder.indexOf(itemId)
      if (index === -1) {
        return []
      }
      const order = (
        scope === 'right' ? stripOrder.slice(index + 1) : stripOrder.slice(0, index)
      ).filter((id) => !folded.has(id))
      const closableIds = new Set(tabs.filter((tab) => !tab.isPinned).map((tab) => tab.id))
      return order.filter((id) => closableIds.has(id))
    },
    [groupId, worktreeId]
  )

  const closeGroup = useCallback(() => {
    // A pane holding any worker, folded or visible, stays whole: nothing in it moves or closes.
    if (keepWorkerPaneOnClose(worktreeId, groupId)) {
      return
    }
    const whenEmptied = captureWorkspaceEmptiedReaction(worktreeId)
    const items = [...(useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [])].filter(
      (item) => item.groupId === groupId
    )
    for (const item of items) {
      closeItem(item.id, { skipEmptyCheck: true })
    }
    // Why: closing tabs doesn't remove the group shell; empty split groups are layout state, collapse the placeholder pane here.
    closeEmptyGroup(worktreeId, groupId)
    whenEmptied()
  }, [closeEmptyGroup, closeItem, groupId, worktreeId])

  const closeAllEditorTabsInGroup = useCallback(() => {
    confirmBulkClose(
      'editors',
      () => selectTabIds('editors'),
      (ids) => {
        for (const id of ids) {
          closeItem(id)
        }
      }
    )
  }, [closeItem, confirmBulkClose, selectTabIds])

  const closeOthers = useCallback(
    (itemId: string) => {
      // Why: store closeOtherTabs strands dirty files if the save dialog is cancelled; route via closeMany to stay dirty-aware.
      confirmBulkClose('others', () => selectTabIds('others', itemId), closeMany)
    },
    [closeMany, confirmBulkClose, selectTabIds]
  )

  const closeInDirection = useCallback(
    (itemId: string, direction: 'left' | 'right') => {
      confirmBulkClose(direction, () => selectTabIds(direction, itemId), closeMany)
    },
    [closeMany, confirmBulkClose, selectTabIds]
  )

  const closeToRight = useCallback(
    (itemId: string) => closeInDirection(itemId, 'right'),
    [closeInDirection]
  )
  const closeToLeft = useCallback(
    (itemId: string) => closeInDirection(itemId, 'left'),
    [closeInDirection]
  )

  return { closeGroup, closeAllEditorTabsInGroup, closeOthers, closeToRight, closeToLeft }
}
