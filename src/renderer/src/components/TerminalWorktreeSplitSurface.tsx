import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { resolveCanvasTerminalLabel } from '../../../shared/tab-title-resolution'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { useAppStore } from '../store'
import { dedupeTabOrder } from '../store/slices/tab-group-state'
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
import TabGroupCanvasLayout from './tab-group/TabGroupCanvasLayout'
import type { CanvasTerminalItem } from './tab-group/CanvasTerminalCard'
import { collectPaneCanvasGroupIds } from './tab-group/pane-canvas-layout-state'
import { usePaneCanvasWorkspaceState } from './tab-group/use-pane-canvas-workspace-state'
import TerminalPaneOverlayLayer from './terminal-pane/TerminalPaneOverlayLayer'
import { RetainedBrowserPaneOverlayLayer } from './browser-pane/assemble-chrome/BrowserPaneOverlayLayer'
import EmulatorPaneOverlayLayer from './emulator-pane/EmulatorPaneOverlayLayer'
import StructuredAgentSessionPaneOverlayLayer from './native-chat/StructuredAgentSessionPaneOverlayLayer'
import AiVaultSessionDropLayer from './tab-group/AiVaultSessionDropLayer'

export const WorktreeSplitSurface = React.memo(function WorktreeSplitSurface({
  worktreeId,
  worktreePath,
  layout,
  focusedGroupId,
  isVisible,
  isControlRoomVisible,
  controlRoomTerminalTabIds,
  controlRoomVisibleTerminalTabIds,
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
  isControlRoomVisible: boolean
  controlRoomTerminalTabIds: ReadonlySet<string> | null
  controlRoomVisibleTerminalTabIds: ReadonlySet<string> | null
  shouldMeasureHiddenWorktree: boolean
  shouldColdParkTerminalPanes: boolean
  isForceParked: boolean
  activityTerminalPortals: ActivityTerminalPortalTarget[]
  backgroundMountTabIds: ReadonlySet<string> | null
  activationDeferredMountTabIds: ReadonlySet<string> | null
}): React.JSX.Element {
  const browserPageIds = useWorktreeBrowserPageIds(worktreeId)
  const needsBrowserGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const executionHostId = useAppStore((state) =>
    getResolvedExecutionHostIdForWorktree(state, worktreeId)
  )
  const isSelectedWorktree = useAppStore((state) => state.activeWorktreeId === worktreeId)
  const rightSidebarOpen = useAppStore((state) => state.rightSidebarOpen)
  const canvasGroupIds = useMemo(() => collectPaneCanvasGroupIds(layout), [layout])
  const canvasGroups = useAppStore((state) => state.groupsByWorktree[worktreeId])
  const canvasUnifiedTabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId])
  const canvasTerminalTabs = useAppStore((state) => state.tabsByWorktree[worktreeId])
  const generatedTabTitlesEnabled = useAppStore(
    (state) => state.settings?.tabAutoGenerateTitle === true
  )
  const canvasActiveTabType = useAppStore(
    (state) =>
      state.activeTabTypeByWorktree[worktreeId] ??
      (state.activeWorktreeId === worktreeId ? state.activeTabType : 'terminal')
  )
  const canvasTerminalItems = useMemo<CanvasTerminalItem[]>(() => {
    const groupsById = new Map((canvasGroups ?? []).map((group) => [group.id, group]))
    const unifiedById = new Map((canvasUnifiedTabs ?? []).map((tab) => [tab.id, tab]))
    const unifiedIdsByGroup = new Map<string, string[]>()
    for (const tab of canvasUnifiedTabs ?? []) {
      const groupIds = unifiedIdsByGroup.get(tab.groupId) ?? []
      groupIds.push(tab.id)
      unifiedIdsByGroup.set(tab.groupId, groupIds)
    }
    const terminalById = new Map((canvasTerminalTabs ?? []).map((tab) => [tab.id, tab]))
    const items: CanvasTerminalItem[] = []
    for (const groupId of canvasGroupIds) {
      const group = groupsById.get(groupId)
      if (!group) {
        continue
      }
      const orderedIds = dedupeTabOrder([
        ...group.tabOrder.filter((tabId) => unifiedById.get(tabId)?.groupId === groupId),
        ...(unifiedIdsByGroup.get(groupId) ?? [])
      ])
      for (const unifiedTabId of orderedIds) {
        const tab = unifiedById.get(unifiedTabId)
        if (!tab || tab.contentType !== 'terminal') {
          continue
        }
        const terminal = terminalById.get(tab.entityId)
        if (!terminal) {
          continue
        }
        items.push({
          terminalTabId: terminal.id,
          unifiedTabId: tab.id,
          groupId,
          label: resolveCanvasTerminalLabel(tab, terminal, generatedTabTitlesEnabled),
          color: tab.color ?? terminal.color
        })
      }
    }
    return items
  }, [
    canvasGroupIds,
    canvasGroups,
    canvasTerminalTabs,
    canvasUnifiedTabs,
    generatedTabTitlesEnabled
  ])
  const canvasTerminalTabIds = useMemo(
    () => canvasTerminalItems.map((item) => item.terminalTabId),
    [canvasTerminalItems]
  )
  const canvasTerminalTabIdSet = useMemo(
    () => new Set(canvasTerminalTabIds),
    [canvasTerminalTabIds]
  )
  const [visibleCanvasTerminalTabIds, setVisibleCanvasTerminalTabIds] =
    useState<ReadonlySet<string> | null>(null)
  const handleVisibleCanvasTerminalTabIdsChange = useCallback((next: ReadonlySet<string>) => {
    setVisibleCanvasTerminalTabIds((current) => {
      if (
        current &&
        current.size === next.size &&
        Array.from(current).every((id) => next.has(id))
      ) {
        return current
      }
      return next
    })
  }, [])
  const focusedTerminalTabId = useMemo(() => {
    if (!focusedGroupId) {
      return undefined
    }
    const group = canvasGroups?.find((candidate) => candidate.id === focusedGroupId)
    if (!group?.activeTabId) {
      return undefined
    }
    return canvasTerminalItems.find((item) => item.unifiedTabId === group.activeTabId)
      ?.terminalTabId
  }, [canvasGroups, canvasTerminalItems, focusedGroupId])
  const { canvasState, updateCanvasState } = usePaneCanvasWorkspaceState({
    ownerKey: `${executionHostId ?? 'unresolved'}:${worktreeId}`,
    terminalTabIds: canvasTerminalTabIds
  })
  useEffect(() => {
    if (
      !isControlRoomVisible &&
      canvasState.mode === 'canvas' &&
      canvasActiveTabType !== 'terminal'
    ) {
      // Canvas presents terminal sessions only. Reveal the split surface when
      // an editor, browser, simulator, or structured agent session becomes active.
      updateCanvasState((current) => ({ ...current, mode: 'split' }))
    }
  }, [canvasActiveTabType, canvasState.mode, isControlRoomVisible, updateCanvasState])
  const shouldKeepPaintable = shouldKeepHiddenWorktreeSurfacePaintable({
    shouldMeasureHiddenWorktree,
    needsBrowserGuestPaint
  })

  return (
    <div
      className={
        isControlRoomVisible
          ? 'absolute inset-0 pointer-events-none'
          : isVisible
            ? 'absolute inset-0 flex'
            : shouldKeepPaintable
              ? 'absolute inset-0 flex opacity-0 pointer-events-none'
              : 'absolute inset-0 hidden'
      }
      inert={!isVisible}
      aria-hidden={!isVisible}
    >
      {isControlRoomVisible ? null : canvasState.mode === 'canvas' ? (
        <TabGroupCanvasLayout
          terminalItems={canvasTerminalItems}
          worktreeId={worktreeId}
          focusedTerminalTabId={focusedTerminalTabId}
          canvasState={canvasState}
          updateCanvasState={updateCanvasState}
          onVisibleTerminalTabIdsChange={handleVisibleCanvasTerminalTabIdsChange}
          trailingChromeInset={rightSidebarOpen ? 'none' : 'window-controls-and-sidebar-toggle'}
        />
      ) : (
        <TabGroupSplitLayout
          layout={layout}
          worktreeId={worktreeId}
          focusedGroupId={focusedGroupId}
          isWorktreeActive={isVisible}
          onOpenCanvas={() => {
            setVisibleCanvasTerminalTabIds(null)
            updateCanvasState((current) => ({ ...current, mode: 'canvas' }))
          }}
        />
      )}
      <TerminalPaneOverlayLayer
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isWorktreeActive={isVisible}
        executionHostId={executionHostId ?? undefined}
        terminalSelectionActive={!isControlRoomVisible || isSelectedWorktree}
        coldParkTerminalPanes={shouldColdParkTerminalPanes}
        isForceParked={isForceParked}
        shouldMeasureHiddenWorktree={shouldMeasureHiddenWorktree}
        roundBottomCorners={isControlRoomVisible || canvasState.mode === 'canvas'}
        canvasTerminalTabIds={
          isControlRoomVisible
            ? controlRoomTerminalTabIds
            : canvasState.mode === 'canvas'
              ? canvasTerminalTabIdSet
              : null
        }
        visibleCanvasTerminalTabIds={
          isControlRoomVisible
            ? controlRoomVisibleTerminalTabIds
            : canvasState.mode === 'canvas'
              ? visibleCanvasTerminalTabIds
              : null
        }
        forceCanvasFallbackPositioning={isControlRoomVisible}
        activityTerminalPortals={activityTerminalPortals}
        backgroundMountTabIds={backgroundMountTabIds}
        activationDeferredMountTabIds={activationDeferredMountTabIds}
      />
      <RetainedBrowserPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible && !isControlRoomVisible && canvasState.mode === 'split'}
        mountEligible={shouldMountRetainedBrowserOverlay({
          isWorktreeVisible: isVisible && !isControlRoomVisible,
          hasDeferredBackgroundMounts: backgroundMountTabIds !== null,
          needsBrowserGuestPaint
        })}
      />
      {!isControlRoomVisible && (isVisible || backgroundMountTabIds === null) ? (
        <EmulatorPaneOverlayLayer
          worktreeId={worktreeId}
          isWorktreeActive={isVisible && canvasState.mode === 'split'}
        />
      ) : null}
      <StructuredAgentSessionPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isVisible && !isControlRoomVisible && canvasState.mode === 'split'}
      />
      <AiVaultSessionDropLayer
        worktreeId={worktreeId}
        enabled={isVisible && !isControlRoomVisible}
      />
    </div>
  )
})
