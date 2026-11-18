import type { ProjectGroupHeaderDragSession } from './project-group-header-drag-contract'
import { buildWorktreeDragPreviewOffsets } from './worktree-drag-preview-offsets'

/** With a floating preview, slides the other rows open at the drop slot, as a workspace drag does, with the line in the gap. */
export function shiftHeaderDrop(
  floatingPreview: boolean,
  session: ProjectGroupHeaderDragSession | null,
  drop: { dropIndex: number; dropIndicatorY: number }
): { dropIndex: number; dropIndicatorY: number; previewOffsetsById?: ReadonlyMap<string, number> } {
  if (!floatingPreview || !session) {
    return drop
  }
  const { offsets, placeholderTop } = buildWorktreeDragPreviewOffsets({
    groupIds: session.sidebarProjectGroupHeaderIds,
    draggedIds: [session.groupId],
    draggingWorktreeId: session.groupId,
    dropIndex: drop.dropIndex,
    rects: session.headerRects.map((rect) => ({
      worktreeId: rect.groupId,
      groupIndex: rect.headerIndex,
      top: rect.top,
      bottom: rect.bottom
    }))
  })
  return {
    dropIndex: drop.dropIndex,
    dropIndicatorY: placeholderTop === null ? drop.dropIndicatorY : Math.max(0, placeholderTop - 3),
    previewOffsetsById: offsets
  }
}
