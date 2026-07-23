import { WorktreeSidebarDropIndicator } from '../../WorktreeSidebarDropIndicator'
import type { useWorktreeDragRuntime } from '../drag/use-runtime'
import type { useWorktreeSidebarHeaderDrag } from '../drag/use-header-drag'

export function renderWorktreeSidebarDropIndicators(args: {
  headerDrag: ReturnType<typeof useWorktreeSidebarHeaderDrag>
  worktreeDragState: ReturnType<typeof useWorktreeDragRuntime>['worktreeDragState']
}): React.ReactNode {
  const { headerDrag, worktreeDragState } = args
  return (
    <>
      {headerDrag.repoDrag.state.dropPlaceholderY !== null &&
      headerDrag.repoDrag.state.dropPlaceholderHeight > 0 ? (
        <div
          role="presentation"
          data-repo-drop-placeholder
          className="pointer-events-none absolute left-2 right-2 z-10 rounded-md border border-dashed border-worktree-sidebar-ring/70 bg-worktree-sidebar-accent/35 transition-[top,height] duration-150 ease-out motion-reduce:transition-none"
          style={{
            top: `${headerDrag.repoDrag.state.dropPlaceholderY}px`,
            height: `${headerDrag.repoDrag.state.dropPlaceholderHeight}px`
          }}
        />
      ) : null}
      {headerDrag.canReorderProjectGroupHeaders &&
      headerDrag.projectGroupDrag.state.draggingGroupId !== null &&
      headerDrag.projectGroupDrag.state.dropIndicatorY !== null ? (
        <WorktreeSidebarDropIndicator y={headerDrag.projectGroupDrag.state.dropIndicatorY} />
      ) : null}
      {headerDrag.hostDrag.state.draggingHostId !== null &&
      headerDrag.hostDrag.state.dropIndicatorY !== null ? (
        <WorktreeSidebarDropIndicator
          y={headerDrag.hostDrag.state.dropIndicatorY}
          className="z-40"
        />
      ) : null}
      {worktreeDragState.draggingWorktreeId !== null &&
      worktreeDragState.dropIndicatorY !== null ? (
        <WorktreeSidebarDropIndicator y={worktreeDragState.dropIndicatorY} />
      ) : null}
    </>
  )
}
