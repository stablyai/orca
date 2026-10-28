import React from 'react'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import type { ActivityTerminalPortalTarget } from './activity/activity-terminal-portal'
import {
  useBrowserGuestPaintRetention,
  useWorktreeBrowserPageIds
} from './browser-pane/host-guest/browser-guest-paint-retention'
import {
  shouldKeepHiddenWorktreeSurfacePaintable,
  shouldMountRetainedBrowserOverlay
} from './browser-pane/host-guest/browser-worktree-surface-paintability'
import TabGroupSplitLayout from './tab-group/TabGroupSplitLayout'
import { WorkspacePaneOverlayLayers } from './WorkspacePaneOverlayLayers'
import { WorkspaceViewProjection } from './workspace-grid-view/workspace-view-projection'
import {
  useWorkspaceViewSurfaceProjection,
  WorkspaceViewSurfacePanels
} from './workspace-grid-view/WorkspaceViewSurfacePanels'
export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  isFocused = isVisible,
  shouldMeasureHiddenWorktree,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode
  focusedGroupId?: string
  isVisible: boolean
  /** False for a grid view member that is on screen but does not own keyboard focus. */
  isFocused?: boolean
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    shouldMeasureHiddenWorktree,
    needsBrowserGuestPaint
  })

  const projection = useWorkspaceViewSurfaceProjection(worktreeId)
  return (
    <WorkspaceViewProjection value={projection}>
      <div
        className={
          isVisible
            ? projection
              ? 'absolute inset-0 pointer-events-none'
              : 'absolute inset-0 flex'
            : shouldKeepPaintable
              ? 'absolute inset-0 flex opacity-0 pointer-events-none'
              : 'absolute inset-0 hidden'
        }
        inert={!isVisible}
        aria-hidden={!isVisible}
      >
        <div
          className={projection ? 'hidden' : 'flex min-h-0 min-w-0 flex-1'}
          inert={Boolean(projection)}
        >
          <TabGroupSplitLayout
            layout={layout}
            worktreeId={worktreeId}
            focusedGroupId={focusedGroupId}
            isWorktreeActive={isVisible && !projection}
            isWorktreeFocused={isFocused && !projection}
          />
        </div>
        {projection ? <WorkspaceViewSurfacePanels projection={projection} /> : null}
        <WorkspacePaneOverlayLayers
          worktreeId={worktreeId}
          worktreePath={worktreePath}
          isVisible={isVisible}
          isFocused={isFocused}
          shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
          shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
          isForceParked={isForceParked}
          activityTerminalPortals={activityTerminalPortals}
          backgroundMountTabIds={backgroundMountTabIds}
          activationDeferredMountTabIds={activationDeferredMountTabIds}
          mountRetainedBrowserOverlay={shouldMountRetainedBrowserOverlay({
            isWorktreeVisible: isVisible,
            hasDeferredBackgroundMounts: backgroundMountTabIds !== null,
            needsBrowserGuestPaint
          })}
          mountEmulatorOverlay={isVisible || backgroundMountTabIds === null}
        />
      </div>
    </WorkspaceViewProjection>
  )
})
