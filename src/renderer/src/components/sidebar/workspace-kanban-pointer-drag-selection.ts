import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

/** Qualify by host so dragging one workspace cannot move its same-ID twin on another host. */
export function resolveWorkspaceKanbanPointerDragSelection(args: {
  sourceWorktreeId: string
  sourceWorktreeIdentity: string
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
}): { worktreeIds: string[]; worktreeIdentities: string[]; worktreeKeys: string[] } {
  if (
    args.selectedWorktreeIds.has(args.sourceWorktreeIdentity) &&
    args.selectedWorktrees.length > 1
  ) {
    return {
      worktreeIds: args.selectedWorktrees.map((worktree) => worktree.id),
      worktreeIdentities: [...args.selectedWorktreeIds],
      // The drop moves the rendered selection only, like worktreeIds.
      worktreeKeys: args.selectedWorktrees.map(getWorktreeHostIdentity)
    }
  }
  return {
    worktreeIds: [args.sourceWorktreeId],
    worktreeIdentities: [args.sourceWorktreeIdentity],
    worktreeKeys: [args.sourceWorktreeIdentity]
  }
}

export type UseWorkspaceKanbanCardPointerDragParams = {
  open: boolean
  boardRef: React.RefObject<HTMLElement | null>
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onDropWorktreesInStatus: (args: {
    /** Host identities of the dragged cards. */
    worktreeKeys: readonly string[]
    status: WorkspaceStatus
    dropIndex: number
  }) => void
  onShouldShowDropIndicator: (worktreeKeys: readonly string[], status: WorkspaceStatus) => boolean
  onPinWorktrees: (worktreeIds: readonly string[]) => void
  onDragTargetChange: (status: WorkspaceStatus | null) => void
  onPinDragTargetChange: (isOver: boolean) => void
}
