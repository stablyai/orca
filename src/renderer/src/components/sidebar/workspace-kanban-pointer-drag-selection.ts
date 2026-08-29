import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'

/**
 * Which rows a Kanban pointer-drag actually moves.
 *
 * Host-qualified (STA-4343): two hosts can publish the same workspace id, so a
 * drag must move the row that was grabbed, not every row sharing its id.
 */
export function resolveWorkspaceKanbanPointerDragSelection(args: {
  sourceWorktreeId: string
  sourceWorktreeIdentity: string
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
}): { worktreeIds: string[]; worktreeIdentities: string[] } {
  if (
    args.selectedWorktreeIds.has(args.sourceWorktreeIdentity) &&
    args.selectedWorktrees.length > 1
  ) {
    return {
      worktreeIds: args.selectedWorktrees.map((worktree) => worktree.id),
      worktreeIdentities: [...args.selectedWorktreeIds]
    }
  }
  return {
    worktreeIds: [args.sourceWorktreeId],
    worktreeIdentities: [args.sourceWorktreeIdentity]
  }
}

/** Params for the Kanban pointer-drag hook; lives here with the selection logic. */
export type UseWorkspaceKanbanCardPointerDragParams = {
  open: boolean
  boardRef: React.RefObject<HTMLElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onDropWorktreesInStatus: (args: {
    worktreeIds: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
  }) => void
  onShouldShowDropIndicator: (worktreeIds: readonly string[], status: WorkspaceStatus) => boolean
  onPinWorktrees: (worktreeIds: readonly string[]) => void
  onDragTargetChange: (status: WorkspaceStatus | null) => void
  onPinDragTargetChange: (isOver: boolean) => void
}
