import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import type { TerminalController } from './use-terminal-controller'
import { useAppStore } from '@/store'
import { visiblePaneViews } from '@/store/slices/window-pane-selection'
import { CrossProjectPaneLayout } from './cross-project-panes/CrossProjectPaneLayout'

export function TerminalSplitWorkspaceSurfaces({
  controller
}: {
  controller: TerminalController
}): React.JSX.Element | null {
  const paneLayout = useAppStore((s) => s.windowPaneLayout)
  const visibleWorkspaces = new Set(visiblePaneViews(paneLayout).map((view) => view.worktreeId))
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
  // Why: this and TerminalSurface are both strict ancestors of every browser <webview>, so a
  // remote controller needs each to drop `hidden` — the per-worktree surface hatch below cannot
  // override an ancestor that stopped compositing.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  if (!anyMountedWorktreeHasLayout && !paneLayout) {
    return null
  }
  return (
    <div
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${
        paneLayout || effectiveActiveLayout
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
    >
      {paneLayout && <CrossProjectPaneLayout />}
      {workspaceSurfaces
        .filter(
          (workspace) =>
            mountedWorktreeIdsRef.current.has(workspace.id) || visibleWorkspaces.has(workspace.id)
        )
        .map((workspace) => {
          const layout = getEffectiveLayoutForWorktree(workspace.id)
          if (!layout) {
            return null
          }
          const isVisible =
            activeView === 'terminal' &&
            (paneLayout
              ? visibleWorkspaces.has(workspace.id)
              : workspace.id === renderedActiveWorktreeId)
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
              isForceParked={!isVisible && forceParkedTerminalWorktreeIds.has(workspace.id)}
              activityTerminalPortals={activityTerminalPortals}
              backgroundMountTabIds={
                isVisible
                  ? null
                  : (backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null)
              }
              activationDeferredMountTabIds={
                isVisible
                  ? null
                  : (activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null)
              }
            />
          )
        })}
    </div>
  )
}
