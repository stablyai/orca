import { useMemo } from 'react'
import { useAppStore } from '@/store'
import type { WorktreeGroupBy } from '../../../../../shared/sidebar-list/row-types'
import { NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK } from '../worktree-list/drag/drop-commit-context'
import { useWorkspaceTagCommands } from './use-workspace-tag-commands'

/** What the sidebar list needs for Tag mode: section order, drop-to-tag, and the board-preview guard. */
export function useSidebarTagModeProps(
  groupBy: WorktreeGroupBy,
  onWorkspaceBoardDragPreviewStart: () => void
) {
  const tagOrderBy = useAppStore((s) => s.tagOrderBy)
  const manualTagOrder = useAppStore((s) => s.manualTagOrder)
  const tagOrder = useMemo(
    () => ({ by: tagOrderBy, manual: manualTagOrder }),
    [manualTagOrder, tagOrderBy]
  )
  const { addTagToIdentities } = useWorkspaceTagCommands()
  return {
    tagOrder,
    onTagWorktrees: addTagToIdentities,
    // Why: a tag-mode drag means "tag this"; auto-opening the status board competes with the tag sections.
    onWorkspaceBoardDragPreviewStart:
      groupBy === 'tag'
        ? NOOP_WORKSPACE_BOARD_DRAG_PREVIEW_CALLBACK
        : onWorkspaceBoardDragPreviewStart
  }
}
