import type { WorkspaceStatus, WorkspaceStatusDefinition } from '../../../../shared/types'
import { getVirtualRowTransform } from './worktree-list-virtual-rows'
import type { WorkspaceKanbanCardTrackedDropTarget } from './workspace-kanban-card-pointer-drag-dom'
import { getWorkspaceStatusFromGroupKey } from './workspace-status'
import type { WorktreeSidebarDragRect } from './worktree-sidebar-drag-autoscroll'
import type {
  WorktreeSidebarDropPreview,
  WorktreeSidebarStatusDropTarget,
  WorktreeSidebarTrackedStatusDropTarget
} from './worktree-sidebar-drop-preview'
import { getWorktreeLineageDropTargetId } from './worktree-lineage-drag-drop'

export const SIDEBAR_POINTER_DRAG_THRESHOLD_PX = 4

export type WorktreeRowDragState = {
  draggingWorktreeId: string | null
  sourceGroupKey: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  previewOffsetsByWorktreeId: ReadonlyMap<string, number>
  pointerY: number | null
}

export const EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS: ReadonlyMap<string, number> = new Map()

export const WORKTREE_ROW_DRAG_INITIAL_STATE: WorktreeRowDragState = {
  draggingWorktreeId: null,
  sourceGroupKey: null,
  dropIndex: null,
  dropIndicatorY: null,
  previewOffsetsByWorktreeId: EMPTY_WORKTREE_DRAG_PREVIEW_OFFSETS,
  pointerY: null
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
  latestBoardDropTarget: WorkspaceKanbanCardTrackedDropTarget | null
  latestStatusDropTarget: WorktreeSidebarTrackedStatusDropTarget | null
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
  target: WorktreeSidebarStatusDropTarget & { lineageParentId: string | null },
  preview: WorktreeSidebarDropPreview | null
): void {
  drag.latestStatusDropTarget =
    target.status || target.isPinDrop || target.lineageParentId
      ? { target, preview, x: drag.currentX, y: drag.currentY }
      : null
}

export function getWorktreeVirtualRowTransform(start: number, previewOffset: number): string {
  const base = getVirtualRowTransform(start)
  return previewOffset === 0 ? base : `${base} translateY(${previewOffset}px)`
}

export function getPointerDropStatusTarget(args: {
  container: HTMLElement
  x: number
  y: number
}): WorktreeSidebarStatusDropTarget & { lineageParentId: string | null } {
  const target = document.elementFromPoint(args.x, args.y)
  if (!(target instanceof Element) || !args.container.contains(target)) {
    return { status: null, isPinDrop: false, lineageParentId: null }
  }
  const pinTarget = target.closest<HTMLElement>('[data-workspace-pin-drop-target]')
  if (pinTarget && args.container.contains(pinTarget)) {
    return { status: null, isPinDrop: true, lineageParentId: null }
  }
  const lineageParentId = getWorktreeLineageDropTargetId({
    container: args.container,
    target,
    pointerY: args.y
  })
  const statusTarget = target.closest<HTMLElement>('[data-workspace-status-drop-target]')
  return {
    status:
      statusTarget && args.container.contains(statusTarget)
        ? ((statusTarget.dataset.workspaceStatus as WorkspaceStatus | undefined) ?? null)
        : null,
    isPinDrop: false,
    lineageParentId
  }
}

export function shouldPreferSidebarStatusDropTarget(args: {
  sourceGroupKey: string
  target: WorktreeSidebarStatusDropTarget
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
}): boolean {
  if (args.target.isPinDrop) {
    return true
  }
  if (!args.target.status) {
    return false
  }
  const sourceStatus = getWorkspaceStatusFromGroupKey(args.sourceGroupKey, args.workspaceStatuses)
  // Why: overlapping edge zones — the section under the pointer must win so guide and drop agree.
  return sourceStatus !== null && args.target.status !== sourceStatus
}

export function uniqueWorktreeIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids))
}

export function getVirtualRowIndex(element: Element): number | null {
  const index = Number.parseInt(element.getAttribute('data-index') ?? '', 10)
  return Number.isNaN(index) ? null : index
}

export function getVirtualRowKey(element: Element): string | null {
  return element.getAttribute('data-worktree-virtual-row-key')
}
