import { useCallback, useMemo } from 'react'
import type React from 'react'
import type { HostSectionRow } from '../../host-section-rows'
import { getWorktreeLineageSiblingDropIndex } from '../../worktree-lineage-drag-drop'
import {
  getWorktreeSidebarDragRectsForRows,
  type WorktreeLineageSiblingReorder,
  type WorktreeSidebarDragSession
} from '../../worktree-sidebar-drag-autoscroll'
import {
  computeWorktreeSidebarDropPreview,
  type WorktreeSidebarDropPreview
} from '../../worktree-sidebar-drop-preview'
import { WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP } from '../viewport/virtual-rows'
import {
  buildWorktreeLineageSiblingGroupIndex,
  resolveWorktreeLineageSiblingSelection
} from './lineage-sibling-groups'

export type WorktreeLineageSiblingDrop = WorktreeSidebarDropPreview & {
  groupKey: string
  worktreeIds: readonly string[]
  draggedIds: readonly string[]
}

export function useWorktreeLineageSiblingDrag(args: {
  rows: readonly HostSectionRow[]
  naturalWorktreeIds: ReadonlySet<string>
  scrollRef: React.RefObject<HTMLDivElement | null>
  sessionRef: React.RefObject<WorktreeSidebarDragSession | null>
}) {
  const siblingGroupIndex = useMemo(
    () => buildWorktreeLineageSiblingGroupIndex(args.rows, args.naturalWorktreeIds),
    [args.naturalWorktreeIds, args.rows]
  )

  const getLineageSiblingReorder = useCallback(
    (rowKey: string, draggedIds: readonly string[]): WorktreeLineageSiblingReorder | null => {
      const container = args.scrollRef.current
      const selection = resolveWorktreeLineageSiblingSelection(
        siblingGroupIndex,
        rowKey,
        draggedIds
      )
      if (!container || !selection) {
        return null
      }
      const rects = getWorktreeSidebarDragRectsForRows(container, selection.rows)
      return rects.length === selection.worktreeIds.length ? { ...selection, rects } : null
    },
    [args.scrollRef, siblingGroupIndex]
  )

  const computeLineageSiblingDrop = useCallback(
    (pointerY: number): WorktreeLineageSiblingDrop | null => {
      const container = args.scrollRef.current
      const siblingReorder = args.sessionRef.current?.lineageSiblingReorder
      if (!container || !siblingReorder) {
        return null
      }
      const containerRect = container.getBoundingClientRect()
      const fixedDropIndex = getWorktreeLineageSiblingDropIndex({
        pointerY: pointerY - containerRect.top + container.scrollTop,
        rects: siblingReorder.rects
      })
      if (fixedDropIndex === null) {
        return null
      }
      const preview = computeWorktreeSidebarDropPreview({
        pointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        rects: siblingReorder.rects,
        groupIds: siblingReorder.worktreeIds,
        draggedIds: siblingReorder.draggedIds,
        fallbackGap: WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP,
        fixedDropIndex
      })
      return preview
        ? {
            groupKey: siblingReorder.key,
            worktreeIds: siblingReorder.worktreeIds,
            draggedIds: siblingReorder.draggedIds,
            ...preview
          }
        : null
    },
    [args.scrollRef, args.sessionRef]
  )

  return useMemo(
    () => ({ getLineageSiblingReorder, computeLineageSiblingDrop }),
    [computeLineageSiblingDrop, getLineageSiblingReorder]
  )
}
