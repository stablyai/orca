import { useMemo } from 'react'
import { computeWorkspaceGridViewCellRects } from '@/lib/workspace-grid-view-cell-rects'
import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import { selectParkedEquivalentMountTabIds } from './terminal/startup-terminal-tab-hold'
import type { TerminalController } from './use-terminal-controller'
import { WorkspaceGridViewEmptyCell } from './workspace-grid-view/WorkspaceGridViewEmptyCell'

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
  // Why: this and TerminalSurface are both strict ancestors of every browser <webview>, so a
  // remote controller needs each to drop `hidden` — the per-worktree surface hatch below cannot
  // override an ancestor that stopped compositing.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  const isGridViewVisible = activeView === 'terminal' && visibleWorkspaceIds.length > 1
  const gridViewCellRects = useMemo(
    () => (isGridViewVisible ? computeWorkspaceGridViewCellRects(visibleWorkspaceIds.length) : []),
    [isGridViewVisible, visibleWorkspaceIds.length]
  )
  if (!anyMountedWorktreeHasLayout) {
    return null
  }
  const gridViewCellRectFor = (workspaceId: string) =>
    gridViewCellRects[visibleWorkspaceIds.indexOf(workspaceId)] ?? null
  const renderedWorkspaceIds = new Set<string>()
  // Why the grid view stays shown without an active layout: opening an empty member can seed
  // its first tab asynchronously, and the other cells must not vanish meanwhile.
  return (
    <div
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${
        effectiveActiveLayout || isGridViewVisible
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
              gridViewCellRect={isGridViewVisible ? gridViewCellRectFor(workspace.id) : null}
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
      {isGridViewVisible
        ? workspaceSurfaces
            .filter(
              (workspace) =>
                visibleWorkspaceIds.includes(workspace.id) &&
                !renderedWorkspaceIds.has(workspace.id)
            )
            .map((workspace) => {
              const rect = gridViewCellRectFor(workspace.id)
              return rect ? (
                <WorkspaceGridViewEmptyCell
                  key={`grid-view-empty-${workspace.id}`}
                  workspaceId={workspace.id}
                  workspacePath={workspace.path}
                  rect={rect}
                  isOpening={workspace.id === renderedActiveWorktreeId}
                />
              ) : null
            })
        : null}
    </div>
  )
}
