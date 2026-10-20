import { useCallback } from 'react'
import { useAppStore } from '../store'
import {
  getWorktreeSplitViewSideHostId,
  isWorktreeSurfaceShown,
  WORKTREE_SPLIT_LEFT_FLEX_VAR
} from '../store/slices/worktree-split-view'
import { activateWorktreeFromSidebar } from '@/lib/sidebar-worktree-activation'
import { useAnyBrowserGuestNeedsPaint } from './browser-pane/host-guest/browser-guest-paint-retention'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import { WorktreeSplitViewDivider } from './worktree-split-view-divider'
import { selectParkedEquivalentMountTabIds } from './terminal/startup-terminal-tab-hold'
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
    splitPartnerWorktreeId,
    startupTerminalTabHold,
    workspaceSurfaces
  } = controller
  const splitViewPair = useAppStore((state) => state.worktreeSplitViewPair)
  const splitViewRatio = useAppStore((state) => state.worktreeSplitViewRatio)
  const setWorktreeSplitViewRatio = useAppStore((state) => state.setWorktreeSplitViewRatio)
  const closeWorktreeSplitView = useAppStore((state) => state.closeWorktreeSplitView)
  // Why: this and TerminalSurface are both strict ancestors of every browser <webview>, so a
  // remote controller needs each to drop `hidden` — the per-worktree surface hatch below cannot
  // override an ancestor that stopped compositing.
  const retainBrowserGuestPaint = useAnyBrowserGuestNeedsPaint(!effectiveActiveLayout)
  const activateSplitPartner = useCallback((worktreeId: string) => {
    const pair = useAppStore.getState().worktreeSplitViewPair
    if (!pair) {
      return
    }
    void activateWorktreeFromSidebar(
      worktreeId,
      getWorktreeSplitViewSideHostId(pair, worktreeId) ?? undefined
    )
  }, [])
  if (!anyMountedWorktreeHasLayout) {
    return null
  }
  // Why both layouts: a half without a group tree would leave a blank column beside the other.
  const isSplitShown =
    splitViewPair !== null &&
    splitPartnerWorktreeId !== null &&
    effectiveActiveLayout !== undefined &&
    mountedWorktreeIdsRef.current.has(splitPartnerWorktreeId) &&
    getEffectiveLayoutForWorktree(splitPartnerWorktreeId) !== undefined
  const shownPartnerWorktreeId = isSplitShown ? splitPartnerWorktreeId : null
  const splitRatioStyle: React.CSSProperties & Record<typeof WORKTREE_SPLIT_LEFT_FLEX_VAR, number> =
    {
      [WORKTREE_SPLIT_LEFT_FLEX_VAR]: splitViewRatio
    }
  return (
    <div
      className={`relative flex flex-1 min-w-0 min-h-0 overflow-hidden${
        effectiveActiveLayout
          ? ''
          : retainBrowserGuestPaint
            ? ' opacity-0 pointer-events-none'
            : ' hidden'
      }`}
      style={isSplitShown ? splitRatioStyle : undefined}
    >
      {workspaceSurfaces
        .filter((workspace) => mountedWorktreeIdsRef.current.has(workspace.id))
        .map((workspace) => {
          const layout = getEffectiveLayoutForWorktree(workspace.id)
          if (!layout) {
            return null
          }
          const isVisible = isWorktreeSurfaceShown(
            {
              activeView,
              renderedActiveWorktreeId,
              splitPartnerWorktreeId: shownPartnerWorktreeId
            },
            workspace.id
          )
          const shouldMeasureHiddenWorktree =
            !isVisible && measurableBackgroundWorktreeIdsRef.current.has(workspace.id)
          const shouldColdParkTerminalPanes =
            !isVisible &&
            !shouldMeasureHiddenWorktree &&
            effectiveParkedTerminalWorktreeIds.has(workspace.id)
          const splitSide =
            isSplitShown && splitViewPair
              ? splitViewPair.leftWorktreeId === workspace.id
                ? 'left'
                : splitViewPair.rightWorktreeId === workspace.id
                  ? 'right'
                  : null
              : null
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
              activationDeferredMountTabIds={selectParkedEquivalentMountTabIds(
                activationDeferredMountTabIdsByWorktreeRef.current.get(workspace.id),
                startupTerminalTabHold,
                workspace.id
              )}
              splitSide={splitSide}
              ownsWorkspaceInput={workspace.id === renderedActiveWorktreeId}
              onActivateSplitPartner={activateSplitPartner}
            />
          )
        })}
      {isSplitShown ? (
        <WorktreeSplitViewDivider
          onRatioCommit={setWorktreeSplitViewRatio}
          onClose={closeWorktreeSplitView}
        />
      ) : null}
    </div>
  )
}
