import { useCallback } from 'react'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import { useAppStore } from '../../store'

export function useTabGroupCloseScopeCommands({
  groupId,
  worktreeId,
  group,
  groupTabs,
  closeItem,
  closeMany,
  leaveWorktreeIfEmpty
}: {
  groupId: string
  worktreeId: string
  group: TabGroup | null
  groupTabs: Tab[]
  closeItem: (itemId: string, opts?: { skipEmptyCheck?: boolean }) => void
  closeMany: (itemIds: string[]) => void
  leaveWorktreeIfEmpty: () => void
}) {
  const closeEmptyGroup = useAppStore((state) => state.closeEmptyGroup)

  const closeGroup = useCallback(() => {
    const items = [...(useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? [])].filter(
      (item) => item.groupId === groupId
    )
    for (const item of items) {
      closeItem(item.id, { skipEmptyCheck: true })
    }
    // Why: closing tabs doesn't remove the group shell; empty split groups are layout state, collapse the placeholder pane here.
    closeEmptyGroup(worktreeId, groupId)
    leaveWorktreeIfEmpty()
  }, [closeEmptyGroup, closeItem, groupId, leaveWorktreeIfEmpty, worktreeId])

  const closeAllEditorTabsInGroup = useCallback(() => {
    for (const item of groupTabs) {
      if (
        item.contentType === 'editor' ||
        item.contentType === 'diff' ||
        item.contentType === 'conflict-review' ||
        item.contentType === 'check-details'
      ) {
        closeItem(item.id)
      }
    }
  }, [closeItem, groupTabs])

  const closeOthers = useCallback(
    (itemId: string) => {
      const item = groupTabs.find((candidate) => candidate.id === itemId)
      if (!item) {
        return
      }
      // Why: store closeOtherTabs strands dirty files if the save dialog is cancelled; route via closeMany to stay dirty-aware.
      const siblingIds = groupTabs
        .filter((candidate) => candidate.id !== itemId && !candidate.isPinned)
        .map((candidate) => candidate.id)
      closeMany(siblingIds)
    },
    [closeMany, groupTabs]
  )

  const closeToRight = useCallback(
    (itemId: string) => {
      // Why: store closeTabsToRight pre-closes dirty tabs; walk tabOrder (canonical L-to-R) via closeMany to stay dirty-aware.
      const order = group?.tabOrder ?? []
      const index = order.indexOf(itemId)
      if (index === -1) {
        return
      }
      const tabById = new Map(groupTabs.map((candidate) => [candidate.id, candidate]))
      const rightIds = order.slice(index + 1).filter((id) => {
        const candidate = tabById.get(id)
        return candidate ? !candidate.isPinned : false
      })
      closeMany(rightIds)
    },
    [closeMany, group, groupTabs]
  )

  const closeToLeft = useCallback(
    (itemId: string) => {
      // Why: see closeToRight — walk tabOrder locally and route through the
      // dirty-aware closeMany path instead of the store helper.
      const order = group?.tabOrder ?? []
      const index = order.indexOf(itemId)
      if (index === -1) {
        return
      }
      const tabById = new Map(groupTabs.map((candidate) => [candidate.id, candidate]))
      const leftIds = order.slice(0, index).filter((id) => {
        const candidate = tabById.get(id)
        return candidate ? !candidate.isPinned : false
      })
      closeMany(leftIds)
    },
    [closeMany, group, groupTabs]
  )

  return { closeGroup, closeAllEditorTabsInGroup, closeOthers, closeToRight, closeToLeft }
}
