import type { WorkspaceStatus, Worktree } from '../../../../shared/worktree/types'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { WorkspacePinTarget } from '../../store/slices/worktree-helpers'
import { getWorktreePinTarget } from './worktree-drag-units'

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
}): {
  worktreeIds: string[]
  worktreeIdentities: string[]
  pinTargets: WorkspacePinTarget[]
} {
  if (
    args.selectedWorktreeIds.has(args.sourceWorktreeIdentity) &&
    args.selectedWorktrees.length > 1
  ) {
    return {
      worktreeIds: args.selectedWorktrees.map((worktree) => worktree.id),
      worktreeIdentities: [...args.selectedWorktreeIds],
      pinTargets: args.selectedWorktrees.map(getWorktreePinTarget)
    }
  }
  const sourceWorktree = args.selectedWorktrees.find(
    (worktree) => getWorktreeHostIdentity(worktree) === args.sourceWorktreeIdentity
  )
  return {
    worktreeIds: [args.sourceWorktreeId],
    worktreeIdentities: [args.sourceWorktreeIdentity],
    pinTargets: [
      sourceWorktree
        ? getWorktreePinTarget(sourceWorktree)
        : {
            worktreeId: args.sourceWorktreeId,
            executionHostId:
              getExecutionHostIdFromWorktreeHostIdentity(args.sourceWorktreeIdentity) ??
              LOCAL_EXECUTION_HOST_ID
          }
    ]
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
  onPinWorktrees: (targets: readonly WorkspacePinTarget[]) => void
  onDragTargetChange: (status: WorkspaceStatus | null) => void
  onPinDragTargetChange: (isOver: boolean) => void
}
