import React, { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { TabGroupLayoutNode } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { ActivityTerminalPortalTarget } from '../../activity/terminal-portal/activity-terminal-portal'
import {
  useBrowserGuestPaintRetention,
  useWorktreeBrowserPageIds
} from '../../browser-pane/host-guest/retention/browser-guest-paint-retention'
import {
  shouldKeepHiddenWorktreeSurfacePaintable,
  shouldMountRetainedBrowserOverlay
} from '../../browser-pane/host-guest/retention/browser-worktree-surface-paintability'
import TabGroupSplitLayout from '../../tab-group/TabGroupSplitLayout'
import { useAppStore } from '../../../store/index'
import { isStructuredTab } from '../../../../../shared/agent-session/view/structured-agent-session-tab'
import { WorkspacePaneOverlayLayers } from './WorkspacePaneOverlayLayers'
import type { TerminalPrewarmStage } from '../worktree-prewarm/terminal-worktree-prewarm'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  shouldMeasureHiddenWorktree,
  prewarmStage,
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
  shouldMeasureHiddenWorktree: boolean
  /** Hover intent: mount, then lay out, then render the revealable terminals while hidden. */
  prewarmStage: TerminalPrewarmStage | null
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  // Allowlist: only views drawn outside the layout (terminals restore from parking snapshots, chats stay mounted).
  // Keyed on membership, not the tab array: title updates replace the array but never a tab's content type.
  const { tabCount, groups } = useAppStore(
    useShallow((state) => ({
      tabCount: state.unifiedTabsByWorktree[worktreeId]?.length ?? 0,
      groups: state.groupsByWorktree[worktreeId]
    }))
  )
  const releaseGateOpen =
    shouldColdParkTerminalPanes && !isForceParked && browserPageIds.length === 0
  const surfaceReleased = useMemo(() => {
    if (!releaseGateOpen || tabCount === 0) {
      return false
    }
    const tabs = useAppStore.getState().unifiedTabsByWorktree[worktreeId] ?? []
    const tabById = new Map<string, (typeof tabs)[number]>()
    for (const tab of tabs) {
      if (tab.contentType === 'simulator') {
        return false
      }
      tabById.set(tab.id, tab)
    }
    return (groups ?? []).every((group) => {
      const active = group.activeTabId ? tabById.get(group.activeTabId) : undefined
      // An empty group shows its landing picker, whose search lives in the layout.
      return (
        active !== undefined &&
        (active.contentType === 'terminal' ||
          active.contentType === 'room' ||
          isStructuredTab(active))
      )
    })
  }, [releaseGateOpen, tabCount, groups, worktreeId])
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    // A mount-stage prewarm stays display:none so its style/layout cost lands in a later task.
    shouldMeasureHiddenWorktree: shouldMeasureHiddenWorktree && prewarmStage !== 'mount',
    needsBrowserGuestPaint
  })

  return (
    <div
      className={
        isVisible
          ? 'absolute inset-0 flex'
          : shouldKeepPaintable
            ? 'absolute inset-0 flex opacity-0 pointer-events-none'
            : 'absolute inset-0 hidden'
      }
      inert={!isVisible}
      aria-hidden={!isVisible}
      data-workspace-surface-id={worktreeId}
    >
      {surfaceReleased ? null : (
        <TabGroupSplitLayout
          layout={layout}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isVisible}
        />
      )}
      <WorkspacePaneOverlayLayers
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isVisible={isVisible}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        hiddenTerminalPrewarm={prewarmStage === 'mount' ? null : prewarmStage}
        shouldColdParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={isForceParked}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
        surfaceReleased={surfaceReleased}
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
