import type { DraggedWorktreeCopies } from './dragged-worktree-copies'
import type { WorkspaceKanbanCardTrackedDropTarget } from '../../workspace-board/drag/workspace-kanban-card-pointer-drag-dom'
import type { WorktreeSidebarDragRect } from './worktree-sidebar-drag-autoscroll'
import type {
  WorktreeSidebarDropPreview,
  WorktreeSidebarStatusDropTarget,
  WorktreeSidebarTrackedStatusDropTarget
} from './worktree-sidebar-drop-preview'

export type WorktreeRowDragState = {
  /** Host identity of the dragged card; preview offsets are keyed the same way. */
  draggingWorktreeId: string | null
  sourceGroupKey: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
  pointerY: number | null
  lineageDropTargetIdentity: string | null
}

export const EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS: ReadonlyMap<string, number> = new Map()

export const WORKTREE_ROW_DRAG_INITIAL_STATE: WorktreeRowDragState = {
  draggingWorktreeId: null,
  sourceGroupKey: null,
  dropIndex: null,
  dropIndicatorY: null,
  previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  pointerY: null,
  lineageDropTargetIdentity: null
}

export type WorktreePointerDrag = {
  pointerId: number
  sourceRow: HTMLElement
  startX: number
  startY: number
  currentX: number
  currentY: number
  worktreeId: string
  /** Host identity of the pressed card. */
  worktreeKey: string
  draggedIds: readonly string[]
  /** The cards picked up, before visible descendants join; a lineage drop nests only these. */
  pickedCopies: DraggedWorktreeCopies
  draggedCopies: DraggedWorktreeCopies
  reorderDraggedIds: readonly string[]
  reorderDraggedKeys: readonly string[]
  reorderUnitDraggedKeys: readonly string[]
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
  lineageParentIdentity: string | null
}

export const NO_WORKTREE_SIDEBAR_DROP_TARGET: WorktreeSidebarLineageDropTarget = {
  status: null,
  isPinDrop: false,
  lineageParentIdentity: null
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
    target.status || target.isPinDrop || target.lineageParentIdentity
      ? {
          target,
          preview,
          x: drag.currentX,
          y: drag.currentY
        }
      : null
}

// Pointer updates repaint on Y-only movement; native drag preserves the previous state identity.
export function clearWorktreeDropPreview(
  previous: WorktreeRowDragState,
  args: { pointerY: number | null; matchPointerY?: boolean; preserveOffsets?: boolean }
): WorktreeRowDragState {
  const unchanged =
    previous.lineageDropTargetIdentity === null &&
    previous.dropIndex === null &&
    previous.dropIndicatorY === null &&
    (args.preserveOffsets === true || previous.previewOffsetsByWorktreeId.size === 0) &&
    (args.matchPointerY !== true || previous.pointerY === args.pointerY)
  return unchanged
    ? previous
    : {
        ...previous,
        lineageDropTargetIdentity: null,
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
    previous.lineageDropTargetIdentity === null &&
    previous.dropIndex === drop.dropIndex &&
    previous.dropIndicatorY === drop.dropIndicatorY &&
    (args.matchPointerY !== true || previous.pointerY === args.pointerY) &&
    areWorktreeDragPreviewOffsetsEqual(
      previous.previewOffsetsByWorktreeId,
      drop.previewOffsetsByWorktreeId
    )
  return unchanged
    ? previous
    : { ...previous, ...drop, lineageDropTargetIdentity: null, pointerY: args.pointerY }
}

export function applyWorktreeLineageDropPreview(
  previous: WorktreeRowDragState,
  lineageDropTargetIdentity: string,
  pointerY: number
): WorktreeRowDragState {
  if (
    previous.lineageDropTargetIdentity === lineageDropTargetIdentity &&
    previous.dropIndex === null &&
    previous.dropIndicatorY === null &&
    previous.pointerY === pointerY
  ) {
    return previous
  }
  // Keep the target under the pointer when switching from a reorder gap to nesting.
  return {
    ...previous,
    lineageDropTargetIdentity,
    dropIndex: null,
    dropIndicatorY: null,
    pointerY
  }
}
