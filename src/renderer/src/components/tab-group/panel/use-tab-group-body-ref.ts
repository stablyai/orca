import { useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { getTabPaneBodyDroppableId } from '../drag/useTabDragSplit'
import { registerTabGroupBody } from '../retained-pane/tab-group-body-geometry'
import { observeTabGroupBodyGridSize } from '@/runtime/sync-runtime-graph/graph-sync-scheduler'

/** The group body's ref: a tab drop target during drags, the retained panes' anchor geometry, and its grid size. */
export function useTabGroupBodyRef({
  groupId,
  worktreeId,
  isTabDragActive
}: {
  groupId: string
  worktreeId: string
  isTabDragActive: boolean
}): (node: HTMLDivElement | null) => (() => void) | undefined {
  const { setNodeRef: setBodyDropRef } = useDroppable({
    id: getTabPaneBodyDroppableId(groupId),
    data: {
      kind: 'pane-body',
      groupId,
      worktreeId
    },
    disabled: !isTabDragActive
  })
  return useCallback(
    (node: HTMLDivElement | null) => {
      setBodyDropRef(node)
      if (!node) {
        return undefined
      }
      const unregisterBody = registerTabGroupBody(groupId, node)
      const stopGridSizeReport = observeTabGroupBodyGridSize(node)
      return () => {
        unregisterBody()
        stopGridSizeReport()
        setBodyDropRef(null)
      }
    },
    [groupId, setBodyDropRef]
  )
}
