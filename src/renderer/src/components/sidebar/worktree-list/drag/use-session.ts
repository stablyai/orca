import { useCallback, useMemo, useRef } from 'react'
import type React from 'react'
import type { WorkspaceStatus } from '../../../../../../shared/worktree/types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
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
import { getNaturalWorktreeKeys } from '../../natural-worktree-keys'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { DraggedWorktreeCopies } from './dragged-worktree-copies'

export type WorktreeStatusDropRequest = {
  pointerY: number
  status: WorkspaceStatus
  /** Host identities, as the sidebar's drag groups key their members. */
  draggedKeys: readonly string[]
}

export type WorktreeDragSession = ReturnType<typeof useWorktreeDragSession>

export function useWorktreeDragSession(args: {
  rows: HostSectionRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const { rows, scrollRef } = args
  const worktreeDragSessionRef = useRef<WorktreeSidebarDragSession | null>(null)
  // Hold cross-group drop anchors separately so expanding target cards cannot move the line under a still pointer.
  const statusDropAnchorsRef = useRef<Map<string, WorktreeSidebarDropAnchor>>(new Map())

  const worktreeDragGroups = useMemo(() => getWorktreeDragGroups(rows), [rows])
  const worktreeDragUnitGroups = useMemo(() => getWorktreeDragUnitGroups(rows), [rows])
  const naturalDragWorktreeKeys = useMemo(() => getNaturalWorktreeKeys(rows), [rows])
  const worktreeLineageDragRows = useMemo(
    () =>
      rows
        .filter((row): row is WorktreeItemRow => row.type === 'item')
        .filter(
          (row) =>
            row.sectionKey !== PINNED_GROUP_KEY ||
            !naturalDragWorktreeKeys.has(getWorktreeHostIdentity(row.worktree))
        )
        .map((row) => ({
          worktreeId: row.worktree.id,
          hostId: row.worktree.hostId,
          depth: row.depth
        })),
    [naturalDragWorktreeKeys, rows]
  )
  const getReorderDraggedIds = useCallback(
    (draggedIds: readonly string[]) =>
      expandDraggedWorktreeIdsForVisibleLineage(worktreeLineageDragRows, draggedIds),
    [worktreeLineageDragRows]
  )
  // Why by identity: by id, a dragged twin would also pull in its other-host copy's children.
  const getReorderDraggedCopies = useCallback(
    (copies: DraggedWorktreeCopies): DraggedWorktreeCopies =>
      expandDraggedWorktreeIdsForVisibleLineage(
        worktreeLineageDragRows.map((row) => ({
          worktreeId: composeWorktreeHostIdentity(row.hostId, row.worktreeId),
          depth: row.depth
        })),
        copies.map((copy) => composeWorktreeHostIdentity(copy.hostId, copy.id))
      ).map((identity) => ({
        id: getWorktreeIdFromHostIdentity(identity),
        hostId: getExecutionHostIdFromWorktreeHostIdentity(identity)
      })),
    [worktreeLineageDragRows]
  )
  const getReorderUnitDraggedKeys = useCallback(
    (sourceGroupKey: string, reorderDraggedKeys: readonly string[]) => {
      const group = worktreeDragUnitGroups.find((candidate) => candidate.key === sourceGroupKey)
      if (!group) {
        return reorderDraggedKeys
      }
      const unitKeys = new Set(group.worktreeIds)
      const filtered = reorderDraggedKeys.filter((key) => unitKeys.has(key))
      return filtered.length > 0 ? filtered : reorderDraggedKeys
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
      // Reevaluate only on pointer/scroll movement so card growth cannot change a stationary drop target.
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
        draggedIds: session.reorderUnitDraggedKeys,
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
        draggedIds: request.draggedKeys,
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

  // Keep session callback identity stable for memoized cards.
  return useMemo(
    () => ({
      worktreeDragSessionRef,
      statusDropAnchorsRef,
      worktreeDragGroups,
      worktreeDragUnitGroups,
      groupKeyByRowKey,
      groupIndexByRowKey,
      getReorderDraggedIds,
      getReorderDraggedCopies,
      getReorderUnitDraggedKeys,
      refreshWorktreeDragSession,
      computeWorktreeDrop,
      computeWorktreeStatusDrop
    }),
    [
      computeWorktreeDrop,
      computeWorktreeStatusDrop,
      getReorderDraggedCopies,
      getReorderDraggedIds,
      getReorderUnitDraggedKeys,
      groupIndexByRowKey,
      groupKeyByRowKey,
      refreshWorktreeDragSession,
      worktreeDragGroups,
      worktreeDragUnitGroups
    ]
  )
}
