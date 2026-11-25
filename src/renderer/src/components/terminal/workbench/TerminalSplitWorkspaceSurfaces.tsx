import { useAnyBrowserGuestNeedsPaint } from '../../browser-pane/host-guest/retention/browser-guest-paint-retention'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import { selectParkedEquivalentMountTabIds } from '../workspace-mounting/startup-terminal-tab-hold'
import { hasPendingBackgroundMounts } from '../workspace-mounting/activation-deferred-tab-admission'
import type { TerminalController } from './use-terminal-controller'
import { useAppStore } from '../../../store/index'
import { CrossWorkspacePane } from '../../cross-workspace-pane/CrossWorkspacePane'

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
    prewarmLeasesRef,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    startupTerminalTabHold,
    workspaceSurfaces
  } = controller
  // Every browser guest has this and TerminalSurface as ancestors; both must allow compositing for remote control to receive frames.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  const crossWorkspacePaneFraction = useAppStore((s) => s.crossWorkspacePane?.fraction ?? 0)
  if (!anyMountedWorktreeHasLayout) {
    return null
  }
  return (
    <div
      className={`flex flex-1 min-w-0 min-h-0 overflow-hidden${
        effectiveActiveLayout
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
    >
      {/* The cross-workspace pane's divider resizes this box, so its share is a flex ratio. */}
      <div
        className="relative flex min-w-0 min-h-0 overflow-hidden"
        style={{ flex: `${1 - crossWorkspacePaneFraction} 1 0%` }}
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
                prewarmStage={
                  shouldMeasureHiddenWorktree
                    ? (prewarmLeasesRef.current.get(workspace.id) ?? null)
                    : null
                }
                shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
                isForceParked={forceParkedTerminalWorktreeIds.has(workspace.id)}
                activityTerminalPortals={activityTerminalPortals}
                backgroundMountTabIds={
                  backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
                }
                hasPendingBackgroundMounts={hasPendingBackgroundMounts(
                  backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null
                )}
                activationDeferredMountTabIds={selectParkedEquivalentMountTabIds(
                  activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id),
                  startupTerminalTabHold,
                  workspace.id
                )}
              />
            )
          })}
      </div>
      <CrossWorkspacePane
        isOnScreen={activeView === 'terminal' && Boolean(effectiveActiveLayout)}
      />
    </div>
  )
}
