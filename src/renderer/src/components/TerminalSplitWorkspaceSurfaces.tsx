import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import ControlRoomTerminalCanvas from './control-room/ControlRoomTerminalCanvas'
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
    controlRoomVisibility,
    effectiveActiveLayout,
    effectiveParkedTerminalWorktreeIds,
    forceParkedTerminalWorktreeIds,
    getEffectiveLayoutForWorktree,
    handleControlRoomVisibilityChange,
    measurableBackgroundWorktreeIdsRef,
    mountedWorktreeIdsRef,
    renderedActiveWorktreeId,
    workspaceSurfaces
  } = controller
  // Why: this and TerminalSurface are both strict ancestors of every browser <webview>, so a
  // remote controller needs each to drop `hidden` — the per-worktree surface hatch below cannot
  // override an ancestor that stopped compositing.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  if (!anyMountedWorktreeHasLayout && activeView !== 'control-room') {
    return null
  }
  return (
    <div
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${
        effectiveActiveLayout || activeView === 'control-room'
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
    >
      {activeView === 'control-room' ? (
        <ControlRoomTerminalCanvas onTerminalVisibilityChange={handleControlRoomVisibilityChange} />
      ) : null}
      {workspaceSurfaces
        .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
        .map((workspace) => {
          const layout = getEffectiveLayoutForWorktree(workspace.id)
          if (!layout) {
            return null
          }
          const isControlRoomVisible =
            activeView === 'control-room' &&
            controlRoomVisibility.terminalTabIdsByWorktree[workspace.id] !== undefined
          const isVisible =
            (activeView === 'terminal' && workspace.id === renderedActiveWorktreeId) ||
            isControlRoomVisible
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
              isControlRoomVisible={isControlRoomVisible}
              controlRoomTerminalTabIds={
                controlRoomVisibility.terminalTabIdsByWorktree[workspace.id] ?? null
              }
              controlRoomVisibleTerminalTabIds={
                controlRoomVisibility.visibleTerminalTabIdsByWorktree[workspace.id] ?? null
              }
              shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
              shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
              isForceParked={
                !isControlRoomVisible && forceParkedTerminalWorktreeIds.has(workspace.id)
              }
              activityTerminalPortals={activityTerminalPortals}
              backgroundMountTabIds={
                isControlRoomVisible
                  ? null
                  : (backgroundMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null)
              }
              activationDeferredMountTabIds={
                isControlRoomVisible
                  ? null
                  : (activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id) ?? null)
              }
            />
          )
        })}
    </div>
  )
}
