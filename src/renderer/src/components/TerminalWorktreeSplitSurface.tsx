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
import type { WorkspaceGridViewCellRect } from '@/lib/workspace-grid-view-cell-rects'
import { WorkspaceGridViewCellHeader } from './workspace-grid-view/WorkspaceGridViewCellHeader'
import {
  focusWorkspaceGridViewCellOnFocus,
  focusWorkspaceGridViewCellOnPointerDown,
  workspaceGridViewCellClassName,
  workspaceGridViewCellStyle,
  workspaceGridViewCellWindowCorners
} from './workspace-grid-view/workspace-grid-view-cell-frame'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  isFocused = isVisible,
  gridViewCellRect = null,
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
  /** Set while this workspace is one cell of the grid view. */
  gridViewCellRect?: WorkspaceGridViewCellRect | null
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

  const gridViewCell = isVisible ? gridViewCellRect : null

  // Why the header slot is always first: entering or leaving the grid view must not change the
  // children's positions, or React would remount the group tree and every live terminal pane.
  return (
    <div
      className={
        gridViewCell
          ? workspaceGridViewCellClassName(gridViewCell)
          : isVisible
            ? 'absolute inset-0 flex'
            : shouldKeepPaintable
              ? 'absolute inset-0 flex opacity-0 pointer-events-none'
              : 'absolute inset-0 hidden'
      }
      style={gridViewCell ? workspaceGridViewCellStyle(gridViewCell) : undefined}
      data-workspace-grid-view-cell={gridViewCell ? worktreeId : undefined}
      inert={!isVisible}
      aria-hidden={!isVisible}
      onPointerDownCapture={
        gridViewCell && !isFocused
          ? (event) => focusWorkspaceGridViewCellOnPointerDown(event.target, worktreeId)
          : undefined
      }
      onFocusCapture={
        gridViewCell && !isFocused
          ? (event) => focusWorkspaceGridViewCellOnFocus(event.target, worktreeId)
          : undefined
      }
    >
      {gridViewCell ? (
        <WorkspaceGridViewCellHeader
          workspaceId={worktreeId}
          workspacePath={worktreePath}
          isFocused={isFocused}
          windowCorners={workspaceGridViewCellWindowCorners(gridViewCell)}
        />
      ) : null}
      <TabGroupSplitLayout
        layout={layout}
        worktreeId={worktreeId}
        focusedGroupId={focusedGroupId}
        isWorktreeActive={isVisible}
        isWorktreeFocused={isFocused}
        touchesWindowTop={!gridViewCell}
      />
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
  )
})
