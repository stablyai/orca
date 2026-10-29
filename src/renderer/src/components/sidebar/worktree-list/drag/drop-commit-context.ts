import type React from 'react'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition
} from '../../../../../../shared/worktree/types'
import type { WorktreeDragGroup } from '../../worktree-manual-order'
import type { WorktreeDragUnitGroup } from '../../worktree-drag-units'
import type { WorktreeSidebarDropPreview } from '../../worktree-sidebar-drop-preview'
import type { WorktreeStatusDropRequest } from './use-session'
import type { WorktreeSidebarLineageDropTarget } from './row-state'
import type { DraggedWorktreeCopies } from './dragged-worktree-copies'

export const NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK = (): void => {}

export type WorktreeStatusDropAtIndexArgs = {
  worktreeIds: readonly string[]
  status: WorkspaceStatus
  dropIndex: number
  groups: readonly WorktreeDragGroup[]
  draggedCopies?: DraggedWorktreeCopies
}

export type ShouldShowWorkspaceBoardDropIndicator = (
  worktreeIds: readonly string[],
  status: WorkspaceStatus,
  draggedCopies?: DraggedWorktreeCopies
) => boolean

export type WorktreeReorderArgs = {
  groups: readonly WorktreeDragGroup[]
  sourceGroupKey: string
  draggedIds: readonly string[]
  dropIndex: number
  draggedCopies?: DraggedWorktreeCopies
}

export type WorktreeDropCommitContext = {
  scrollRef: React.RefObject<HTMLDivElement | null>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  worktreeDragGroups: readonly WorktreeDragGroup[]
  worktreeDragUnitGroups: readonly WorktreeDragUnitGroup[]
  computeWorktreeDrop: (pointerY: number) => WorktreeSidebarDropPreview | null
  computeWorktreeStatusDrop: (
    request: WorktreeStatusDropRequest
  ) => WorktreeSidebarDropPreview | null
  refreshWorktreeDragSession: () => boolean
  getEligibleLineageDropTarget: (
    target: WorktreeSidebarLineageDropTarget,
    draggedIds: readonly string[]
  ) => WorktreeSidebarLineageDropTarget
  commitWorktreeLineageParentDrop: (draggedIds: readonly string[], parentId: string) => boolean
  clearReorderedWorktreeParents: (args: {
    draggedIds: readonly string[]
    sourceGroupKey: string
  }) => void
  clearWorktreeDrag: () => void
  onMoveWorktreesToStatus: (
    worktreeIds: readonly string[],
    status: WorkspaceStatus,
    draggedCopies?: DraggedWorktreeCopies
  ) => void
  onMoveWorktreesToStatusAtIndex: (args: WorktreeStatusDropAtIndexArgs) => void
  onReorderWorktrees: (args: WorktreeReorderArgs) => void
  onPinWorktrees: (worktreeIds: readonly string[], draggedCopies?: DraggedWorktreeCopies) => void
}
