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
import { WORKTREE_SPLIT_LEFT_FLEX_VAR } from '../store/slices/worktree-split-view'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  shouldMeasureHiddenWorktree,
  shouldColdParkTerminalPanes,
  isForceParked,
  activityTerminalPortals,
  backgroundMountTabIds,
  activationDeferredMountTabIds,
  splitSide,
  ownsWorkspaceInput,
  onActivateSplitPartner
}: {
  worktreeId: string
  worktreePath: string
  layout: TabGroupLayoutNode
  focusedGroupId?: string
  isVisible: boolean
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
  /** Set while this surface is one half of a worktree split view. */
  splitSide: 'left' | 'right' | null
  ownsWorkspaceInput: boolean
  onActivateSplitPartner: (worktreeId: string) => void
}): React.JSX.Element {
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    shouldMeasureHiddenWorktree,
    needsBrowserGuestPaint
  })

  const isSplitHalf = isVisible && splitSide !== null
  return (
    <div
      className={
        isSplitHalf
          ? // Why relative: it stays the containing block the pane overlays anchor and measure against.
            'relative flex min-w-0 min-h-0 overflow-hidden'
          : isVisible
            ? 'absolute inset-0 flex'
            : shouldKeepPaintable
              ? 'absolute inset-0 flex opacity-0 pointer-events-none'
              : 'absolute inset-0 hidden'
      }
      // Why CSS order + a container variable: the surfaces stay siblings in a stable order, so
      // swapping sides or dragging the divider never re-parents (and remounts) a workspace.
      style={
        isSplitHalf
          ? splitSide === 'left'
            ? { order: 0, flex: `var(${WORKTREE_SPLIT_LEFT_FLEX_VAR}) 1 0%` }
            : { order: 2, flex: `calc(1 - var(${WORKTREE_SPLIT_LEFT_FLEX_VAR})) 1 0%` }
          : undefined
      }
      data-worktree-split-side={isSplitHalf ? splitSide : undefined}
      onPointerDownCapture={
        isSplitHalf && !ownsWorkspaceInput
          ? (event) => {
              // Why primary only: right/middle clicks open menus or paste, not a worktree switch.
              if (event.button === 0) {
                onActivateSplitPartner(worktreeId)
              }
            }
          : undefined
      }
      inert={!isVisible}
      aria-hidden={!isVisible}
    >
      <TabGroupSplitLayout
        layout={layout}
        worktreeId={worktreeId}
        focusedGroupId={focusedGroupId}
        isWorktreeActive={isVisible}
        ownsWorkspaceInput={ownsWorkspaceInput}
      />
      <WorkspacePaneOverlayLayers
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isVisible={isVisible}
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
        ownsWorkspaceInput={ownsWorkspaceInput}
      />
    </div>
  )
})
