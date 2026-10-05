import type { WorkspaceKanbanCardTrackedDropTarget } from '../../workspace-kanban-card-pointer-drag-dom'
import type { WorktreeSidebarDragRect } from '../../worktree-sidebar-drag-autoscroll'
import type {
  WorktreeSidebarDropPreview,
  WorktreeSidebarStatusDropTarget,
  WorktreeSidebarTrackedStatusDropTarget
} from '../../worktree-sidebar-drop-preview'

export type WorktreeRowDragState = {
  draggingWorktreeId: string | null
  sourceGroupKey: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
  pointerY: number | null
  lineageDropTargetId: string | null
}

export const EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS: ReadonlyMap<string, number> = new Map()

export const WORKTREE_ROW_DRAG_INITIAL_STATE: WorktreeRowDragState = {
  draggingWorktreeId: null,
  sourceGroupKey: null,
  dropIndex: null,
  dropIndicatorY: null,
  previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  pointerY: null,
  lineageDropTargetId: null
}

export type WorktreePointerDrag = {
  pointerId: number
  sourceRow: HTMLElement
  startX: number
  startY: number
  currentX: number
  currentY: number
  worktreeId: string
  draggedIds: readonly string[]
  reorderDraggedIds: readonly string[]
  reorderUnitDraggedIds: readonly string[]
  sourceGroupKey: string
  rects: readonly WorktreeSidebarDragRect[]
  active: boolean
  preview: HTMLElement | null
  previewOffsetX: number
  previewOffsetY: number
  workspaceBoardDragPreviewRequested: boolean
  frameId: number | null
  reorderIntent: { dropIndex: number; pointerY: number; startedAt: number } | null
  latestBoardDropTarget: WorkspaceKanbanCardTrackedDropTarget | null
  latestStatusDropTarget: WorktreeSidebarTrackedStatusDropTarget | null
}

export type WorktreeSidebarLineageDropTarget = WorktreeSidebarStatusDropTarget & {
  lineageParentId: string | null
}

export const NO_WORKTREE_SIDEBAR_DROP_TARGET: WorktreeSidebarLineageDropTarget = {
  status: null,
  isPinDrop: false,
  lineageParentId: null
}

export function areWorktreeDragPreviewOffsetsEqual(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false
    }
  }
  return true
}

export function updateLatestWorktreeStatusDropTarget(
  drag: WorktreePointerDrag,
  target: WorktreeSidebarLineageDropTarget,
  preview: WorktreeSidebarDropPreview | null
): void {
  drag.latestStatusDropTarget =
    target.status || target.isPinDrop || target.lineageParentId
      ? {
          target,
          preview,
          x: drag.currentX,
          y: drag.currentY
        }
      : null
}

// Why matchPointerY: pointer-driven updates must repaint when only the pointer moved; native-drag
// updates deliberately keep the previous state identity in that case.
export function clearWorktreeDropPreview(
  previous: WorktreeRowDragState,
  args: { pointerY: number | null; matchPointerY?: boolean; preserveOffsets?: boolean }
): WorktreeRowDragState {
  const unchanged =
    previous.lineageDropTargetId === null &&
    previous.dropIndex === null &&
    previous.dropIndicatorY === null &&
    (args.preserveOffsets === true || previous.previewOffsetsByWorktreeId.size === 0) &&
    (args.matchPointerY !== true || previous.pointerY === args.pointerY)
  return unchanged
    ? previous
    : {
        ...previous,
        lineageDropTargetId: null,
        dropIndex: null,
        dropIndicatorY: null,
        previewOffsetsByWorktreeId: args.preserveOffsets
          ? previous.previewOffsetsByWorktreeId
          : EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
        pointerY: args.pointerY
      }
}

export function applyWorktreeDropPreview(
  previous: WorktreeRowDragState,
  drop: WorktreeSidebarDropPreview,
  args: { pointerY: number; matchPointerY?: boolean }
): WorktreeRowDragState {
  const unchanged =
    previous.lineageDropTargetId === null &&
    previous.dropIndex === drop.dropIndex &&
    previous.dropIndicatorY === drop.dropIndicatorY &&
    (args.matchPointerY !== true || previous.pointerY === args.pointerY) &&
    areWorktreeDragPreviewOffsetsEqual(
      previous.previewOffsetsByWorktreeId,
      drop.previewOffsetsByWorktreeId
    )
  return unchanged
    ? previous
    : { ...previous, ...drop, lineageDropTargetId: null, pointerY: args.pointerY }
}

export function applyWorktreeLineageDropPreview(
  previous: WorktreeRowDragState,
  lineageDropTargetId: string,
  pointerY: number
): WorktreeRowDragState {
  if (
    previous.lineageDropTargetId === lineageDropTargetId &&
    previous.dropIndex === null &&
    previous.dropIndicatorY === null &&
    previous.pointerY === pointerY
  ) {
    return previous
  }
  // Keep the target under the pointer when switching from a reorder gap to nesting.
  return {
    ...previous,
    lineageDropTargetId,
    dropIndex: null,
    dropIndicatorY: null,
    pointerY
  }
}
