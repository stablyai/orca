import { useCallback, useMemo, useRef } from 'react'
import type React from 'react'
import type { WorkspaceStatus } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../host-section-rows'
import { PINNED_GROUP_KEY } from '../grouping/group-keys'
import { WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP } from '../viewport/virtual-rows'
import { getWorkspaceStatusGroupKey } from '../../workspace-status'
import { expandDraggedWorktreeIdsForVisibleLineage } from '../../worktree-manual-order'
import { getWorktreeDragUnitGroups } from '../../worktree-drag-units'
import {
  getWorktreeSidebarDragRectsForGroup,
  refreshWorktreeSidebarDragSession,
  type WorktreeSidebarDragRect,
  type WorktreeSidebarDragSession
} from '../../worktree-sidebar-drag-autoscroll'
import {
  shouldReevaluateWorktreeSidebarDropAnchor,
  type WorktreeSidebarDragGrab,
  type WorktreeSidebarDropAnchor
} from '../../worktree-sidebar-drag-geometry'
import {
  computeWorktreeSidebarDropPreview,
  type WorktreeSidebarDropPreview
} from '../../worktree-sidebar-drop-preview'
import { getWorktreeDragGroups, getWorktreeDragIndexes } from './groups'
import type { WorktreeItemRow } from '../listing/renderable-rows'

export type WorktreeStatusDropRequest = {
  pointerY: number
  status: WorkspaceStatus
  draggedIds: readonly string[]
}

export type WorktreeDragSession = ReturnType<typeof useWorktreeDragSession>

// Owns the geometry side of a sidebar row drag: which groups exist, which ids travel
// together, and where the insertion line lands for a given pointer position.
export function useWorktreeDragSession(args: {
  rows: HostSectionRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const { rows, scrollRef } = args
  const worktreeDragSessionRef = useRef<WorktreeSidebarDragSession | null>(null)
  // Why: cross-group hovers hit-test a group the session never captured, so hold
  // that group's drop decision separately or a card expanding in the target group
  // moves the insertion line under a still pointer.
  const statusDropAnchorsRef = useRef<Map<string, WorktreeSidebarDropAnchor>>(new Map())

  const worktreeDragGroups = useMemo(() => getWorktreeDragGroups(rows), [rows])
  const worktreeDragUnitGroups = useMemo(() => getWorktreeDragUnitGroups(rows), [rows])
  const naturalDragWorktreeIds = useMemo(
    () =>
      new Set(
        rows.flatMap((row) =>
          row.type === 'item' && row.sectionKey !== PINNED_GROUP_KEY ? [row.worktree.id] : []
        )
      ),
    [rows]
  )
  const worktreeLineageDragRows = useMemo(
    () =>
      rows
        .filter((row): row is WorktreeItemRow => row.type === 'item')
        .filter(
          (row) =>
            row.sectionKey !== PINNED_GROUP_KEY || !naturalDragWorktreeIds.has(row.worktree.id)
        )
        .map((row) => ({ worktreeId: row.worktree.id, depth: row.depth })),
    [naturalDragWorktreeIds, rows]
  )
  const getReorderDraggedIds = useCallback(
    (draggedIds: readonly string[]) =>
      expandDraggedWorktreeIdsForVisibleLineage(worktreeLineageDragRows, draggedIds),
    [worktreeLineageDragRows]
  )
  const getReorderUnitDraggedIds = useCallback(
    (sourceGroupKey: string, reorderDraggedIds: readonly string[]) => {
      const group = worktreeDragUnitGroups.find((candidate) => candidate.key === sourceGroupKey)
      if (!group) {
        return reorderDraggedIds
      }
      const unitIds = new Set(group.worktreeIds)
      const filtered = reorderDraggedIds.filter((worktreeId) => unitIds.has(worktreeId))
      return filtered.length > 0 ? filtered : reorderDraggedIds
    },
    [worktreeDragUnitGroups]
  )
  const { groupKeyByRowKey, groupIndexByRowKey } = useMemo(
    () => getWorktreeDragIndexes(rows),
    [rows]
  )
  const refreshWorktreeDragSession = useCallback((): boolean => {
    const session = worktreeDragSessionRef.current
    const container = scrollRef.current
    if (!session || !container) {
      return false
    }

    const refreshedSession = refreshWorktreeSidebarDragSession({
      session,
      groups: worktreeDragGroups,
      unitGroups: worktreeDragUnitGroups,
      rects: getWorktreeSidebarDragRectsForGroup(container, session.sourceGroupKey)
    })
    worktreeDragSessionRef.current = refreshedSession
    return refreshedSession !== null
  }, [scrollRef, worktreeDragGroups, worktreeDragUnitGroups])
  const computeWorktreeDropForGroup = useCallback(
    (dropArgs: {
      pointerY: number
      groupKey: string
      rects: readonly WorktreeSidebarDragRect[]
      draggedIds: readonly string[]
      draggingWorktreeId?: string | null
      grab?: WorktreeSidebarDragGrab | null
      anchor?: WorktreeSidebarDropAnchor | null
    }): WorktreeSidebarDropPreview | null => {
      const container = scrollRef.current
      if (!container) {
        return null
      }
      const group = worktreeDragUnitGroups.find((candidate) => candidate.key === dropArgs.groupKey)
      if (!group) {
        return null
      }
      const containerRect = container.getBoundingClientRect()
      return computeWorktreeSidebarDropPreview({
        pointerY: dropArgs.pointerY,
        containerTop: containerRect.top,
        scrollTop: container.scrollTop,
        rects: dropArgs.rects,
        groupIds: group.worktreeIds,
        draggedIds: dropArgs.draggedIds,
        draggingWorktreeId: dropArgs.draggingWorktreeId,
        fallbackGap: WORKTREE_SIDEBAR_VIRTUAL_ROW_GAP,
        grab: dropArgs.grab,
        anchor: dropArgs.anchor
      })
    },
    [scrollRef, worktreeDragUnitGroups]
  )
  const computeWorktreeDrop = useCallback(
    (pointerY: number): WorktreeSidebarDropPreview | null => {
      const session = worktreeDragSessionRef.current
      const container = scrollRef.current
      if (!session || !container) {
        return null
      }
      const scrollTop = container.scrollTop
      // Why: only real pointer or scroll movement should re-decide the slot; a
      // card growing under a still pointer must not move it.
      const anchor = shouldReevaluateWorktreeSidebarDropAnchor({
        anchor: session.anchor,
        pointerY,
        scrollTop
      })
        ? null
        : session.anchor
      const preview = computeWorktreeDropForGroup({
        pointerY,
        groupKey: session.sourceGroupKey,
        rects: session.rects,
        draggedIds: session.reorderUnitDraggedIds,
        draggingWorktreeId: session.draggingWorktreeId,
        grab: session.grab,
        anchor
      })
      worktreeDragSessionRef.current = {
        ...session,
        anchor: preview ? { beforeWorktreeId: preview.dropAnchorId, pointerY, scrollTop } : null
      }
      return preview
    },
    [computeWorktreeDropForGroup, scrollRef]
  )
  const computeWorktreeStatusDrop = useCallback(
    (request: WorktreeStatusDropRequest): WorktreeSidebarDropPreview | null => {
      const container = scrollRef.current
      if (!container) {
        return null
      }
      const groupKey = getWorkspaceStatusGroupKey(request.status)
      const session = worktreeDragSessionRef.current
      const scrollTop = container.scrollTop
      const heldAnchor = statusDropAnchorsRef.current.get(groupKey) ?? null
      const anchor = shouldReevaluateWorktreeSidebarDropAnchor({
        anchor: heldAnchor,
        pointerY: request.pointerY,
        scrollTop
      })
        ? null
        : heldAnchor
      const preview = computeWorktreeDropForGroup({
        pointerY: request.pointerY,
        groupKey,
        rects: getWorktreeSidebarDragRectsForGroup(container, groupKey),
        draggedIds: request.draggedIds,
        draggingWorktreeId: session?.draggingWorktreeId ?? null,
        grab: session?.grab ?? null,
        anchor
      })
      if (preview) {
        statusDropAnchorsRef.current.set(groupKey, {
          beforeWorktreeId: preview.dropAnchorId,
          pointerY: request.pointerY,
          scrollTop
        })
      } else {
        statusDropAnchorsRef.current.delete(groupKey)
      }
      return preview
    },
    [computeWorktreeDropForGroup, scrollRef]
  )

  // Why: consumers pass session-derived callbacks into memoised cards; a fresh object every
  // render would defeat those bail-outs.
  return useMemo(
    () => ({
      worktreeDragSessionRef,
      statusDropAnchorsRef,
      worktreeDragGroups,
      worktreeDragUnitGroups,
      groupKeyByRowKey,
      groupIndexByRowKey,
      getReorderDraggedIds,
      getReorderUnitDraggedIds,
      refreshWorktreeDragSession,
      computeWorktreeDrop,
      computeWorktreeStatusDrop
    }),
    [
      computeWorktreeDrop,
      computeWorktreeStatusDrop,
      getReorderDraggedIds,
      getReorderUnitDraggedIds,
      groupIndexByRowKey,
      groupKeyByRowKey,
      refreshWorktreeDragSession,
      worktreeDragGroups,
      worktreeDragUnitGroups
    ]
  )
}
