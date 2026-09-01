import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import type { TerminalController } from './use-terminal-controller'

export function TerminalSplitWorkspaceSurfaces({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const {
    activationDeferredMountTabIdsByWorktreeRef,
    activeGroupIdByWorktree,
    activeView,
    activityTerminalPortals,
    anyMountedWorktreeHasLayout,
    backgroundMountTabIdsByWorktreeRef,
    effectiveActiveLayout,
    effectiveParkedTerminalWorktreeIds,
    forceParkedTerminalWorktreeIds,
    getEffectiveLayoutForWorktree,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    workspaceSurfaces
  } = controller
  if (!anyMountedWorktreeHasLayout) {
    return null
  }
  return (
    <div
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${effectiveActiveLayout ? '' : ' hidden'}`}
    >
      {workspaceSurfaces
        .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
        .map((workspace) => {
          const layout = getEffectiveLayoutForWorktree(workspace.id)
          if (!layout) {
            return null
          }
          const isVisible = activeView === 'terminal' && workspace.id === renderedActiveWorktreeId
          const shouldMeasureHiddenWorktree =
            !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
          const shouldColdParkTerminalPanes =
            !isVisible &&
            !shouldMeasureHiddenWorktree &&
            effectiveParkedTerminalWorktreeIds.has(workspace.id)
          return (
            <WorktreeSplitSurface
              key={`tab-groups-${workspace.id}`}
              worktreeId={workspace.id}
              worktreePath={workspace.path}
              layout={layout}
              focusedGroupId={activeGroupIdByWorktree[workspace.id]}
              isVisible={isVisible}
              shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
              shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
              isForceParked={forceParkedTerminalWorktreeIds.has(workspace.id)}
              activityTerminalPortals={activityTerminalPortals}
              backgroundMountTabIds={
                backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
              }
              activationDeferredMountTabIds={
                activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
              }
            />
          )
        })}
    </div>
  )
}
