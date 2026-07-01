import type { WorktreeLineage } from '../../../../shared/types'
import type { WorktreeSidebarDragRect } from './worktree-sidebar-drag-autoscroll'

export function getLineageDragOutWorktreeIds(args: {
  draggedIds: readonly string[]
  lineageById: Readonly<Record<string, WorktreeLineage>>
  rects: readonly WorktreeSidebarDragRect[]
  localY: number
}): string[] {
  const rectByWorktreeId = new Map(args.rects.map((rect) => [rect.worktreeId, rect]))
  const draggedSet = new Set<string>()
  const dragOutIds: string[] = []

  for (const worktreeId of args.draggedIds) {
    if (draggedSet.has(worktreeId)) {
      continue
    }
    draggedSet.add(worktreeId)

    const parentId = args.lineageById[worktreeId]?.parentWorktreeId
    if (!parentId) {
      continue
    }
    const parentRect = rectByWorktreeId.get(parentId)
    if (!parentRect) {
      continue
    }
    if (args.localY < parentRect.top || args.localY > parentRect.bottom) {
      dragOutIds.push(worktreeId)
    }
  }

  return dragOutIds
}
