import { useAppStore } from '@/store'
import { selectShownWorkspaceView } from '@/lib/workspace-view-catalog'
import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import { selectParkedEquivalentMountTabIds } from './terminal/startup-terminal-tab-hold'
import type { TerminalController } from './use-terminal-controller'
import { WorkspaceViewMissingPanels } from './workspace-grid-view/WorkspaceViewMissingPanels'
import { WorkspaceViewResizeHandles } from './workspace-grid-view/WorkspaceViewResizeHandles'

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
    startupTerminalTabHold,
    visibleWorkspaceIds,
    workspaceSurfaces
  } = controller
  // Every browser guest has this and TerminalSurface as ancestors; both must allow compositing for remote control to receive frames.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  const workspaceView = useAppStore(selectShownWorkspaceView)
  if (!anyMountedWorktreeHasLayout && !workspaceView) {
    return null
  }
  const renderedWorkspaceIds = new Set<string>()
  return (
    <div
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${
        effectiveActiveLayout || workspaceView
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
    >
      {workspaceSurfaces
        .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
        .map((workspace) => {
          const layout = getEffectiveLayoutForWorktree(workspace.id)
          if (!layout) {
            return null
          }
          renderedWorkspaceIds.add(workspace.id)
          const isVisible = activeView === 'terminal' && visibleWorkspaceIds.includes(workspace.id)
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
              isFocused={isVisible && workspace.id === renderedActiveWorktreeId}
              shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
              shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
              isForceParked={forceParkedTerminalWorktreeIds.has(workspace.id)}
              activityTerminalPortals={activityTerminalPortals}
              backgroundMountTabIds={
                backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
              }
              activationDeferredMountTabIds={selectParkedEquivalentMountTabIds(
                activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id),
                startupTerminalTabHold,
                workspace.id
              )}
            />
          )
        })}
      {workspaceView ? (
        <WorkspaceViewMissingPanels renderedWorkspaceIds={renderedWorkspaceIds} />
      ) : null}
      <WorkspaceViewResizeHandles />
    </div>
  )
}
