import { useMemo } from 'react'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import type { useWorktreeDragRuntime } from './use-runtime'
import type { useWorktreeDragSession } from './use-session'
import type { useWorktreeLineageDropCommit } from './use-lineage-drop-commit'

/** Bundles the drag session, lineage commits, and viewport callbacks every drop path reads. */
export function useWorktreeDropCommitContext(args: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  session: ReturnType<typeof useWorktreeDragSession>
  lineageDrop: ReturnType<typeof useWorktreeLineageDropCommit>
  runtime: ReturnType<typeof useWorktreeDragRuntime>
  onMoveWorktreesToStatus: WorktreeDropCommitContext['onMoveWorktreesToStatus']
  onMoveWorktreesToStatusAtIndex: WorktreeDropCommitContext['onMoveWorktreesToStatusAtIndex']
  onReorderWorktrees: WorktreeDropCommitContext['onReorderWorktrees']
  onPinWorktrees: WorktreeDropCommitContext['onPinWorktrees']
}): WorktreeDropCommitContext {
  const { scrollRef, workspaceStatuses, session, lineageDrop, runtime } = args
  const {
    onMoveWorktreesToStatus,
    onMoveWorktreesToStatusAtIndex,
    onReorderWorktrees,
    onPinWorktrees
  } = args
  return useMemo<WorktreeDropCommitContext>(
    () => ({
      scrollRef,
      workspaceStatuses,
      worktreeDragGroups: session.worktreeDragGroups,
      worktreeDragUnitGroups: session.worktreeDragUnitGroups,
      computeWorktreeDrop: session.computeWorktreeDrop,
      computeWorktreeStatusDrop: session.computeWorktreeStatusDrop,
      refreshWorktreeDragSession: session.refreshWorktreeDragSession,
      getEligibleLineageDropTarget: lineageDrop.getEligibleLineageDropTarget,
      commitWorktreeLineageParentDrop: lineageDrop.commitWorktreeLineageParentDrop,
      clearReorderedWorktreeParents: lineageDrop.clearReorderedWorktreeParents,
      clearWorktreeDrag: runtime.clearWorktreeDrag,
      onMoveWorktreesToStatus,
      onMoveWorktreesToStatusAtIndex,
      onReorderWorktrees,
      onPinWorktrees
    }),
    [
      lineageDrop.clearReorderedWorktreeParents,
      lineageDrop.commitWorktreeLineageParentDrop,
      lineageDrop.getEligibleLineageDropTarget,
      onMoveWorktreesToStatus,
      onMoveWorktreesToStatusAtIndex,
      onPinWorktrees,
      onReorderWorktrees,
      runtime.clearWorktreeDrag,
      scrollRef,
      session.computeWorktreeDrop,
      session.computeWorktreeStatusDrop,
      session.refreshWorktreeDragSession,
      session.worktreeDragGroups,
      session.worktreeDragUnitGroups,
      workspaceStatuses
    ]
  )
}
