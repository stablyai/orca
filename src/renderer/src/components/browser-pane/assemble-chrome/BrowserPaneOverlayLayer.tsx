import { focusWorkspaceViewAnchor } from '@/lib/workspace-view-actions'
import { memo, useCallback, useEffect, useMemo } from 'react'
import { registerBrowserOverlaySlotViewport } from '../host-guest/browser-page-viewport'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import { resolveBrowserWorkspaceOwner } from '@/lib/browser-workspace-source-resolution'
import type { BrowserTab as BrowserTabState } from '../../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import BrowserPane from './browser-workspace-pane'
import { DeferredBrowserContent } from './DeferredBrowserContent'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { resolveBrowserChromeShortcutScope } from './browser-chrome-shortcut-scope'
import { tabGroupBodyAnchorName } from '../../tab-group/tab-group-body-anchor'
import { isFloatingWorkspaceId } from '../../../../../shared/floating-workspace-worktree'
import { useBrowserGuestPaintRetention } from '../host-guest/browser-guest-paint-retention'
import {
  isClientHostedBrowserRowSelectionLive,
  useClientHostedBrowserRowSelection,
  useClientHostedBrowserRows
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import { ClientHostedBrowserHostRowPane } from '../client-hosted-browser-host-row-pane'
import { useAnyBrowserPageMountAdmission } from '../host-guest/browser-page-mount-admission'
import { useWorkspaceViewProjection } from '../../workspace-grid-view/workspace-view-projection'
import { workspaceViewAnchorId } from '@/lib/workspace-view-layout'

// Why: Electron <webview> destroys its guest on DOM reparent, so BrowserPanes render at worktree level and moving a tab between groups only swaps the overlay's CSS position-anchor.

type BrowserOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

type BrowserOverlaySlotProps = {
  browserTab: BrowserTabState
  isWorktreeActive: boolean
  // Why: undefined = orphan tab (in browserTabs but not referenced by any group's unified-tab list); the fallback branch keeps these hidden.
  groupId: string | undefined
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  // Why: overlay is a sibling of the group layout, so pane focus doesn't bubble to TabGroupPanel; re-sync it here or split-view clicks leave activeGroupIdByWorktree stale.
  onFocusOwningGroup: ((groupId: string) => void) | undefined
}

// Why: memoize each slot so unrelated worktree mutations don't cascade a re-render into every BrowserPane subtree.
const BrowserOverlaySlot = memo(function BrowserOverlaySlot({
  browserTab,
  isWorktreeActive,
  groupId,
  isActive,
  chromeShortcutScope,
  onFocusOwningGroup
}: BrowserOverlaySlotProps): React.JSX.Element {
  const viewProjection = useWorkspaceViewProjection()
  // Why: persistent page viewports (webview guests) live under this root so they survive BrowserPane chrome unmounts without reparenting.
  const setSlotViewportRef = useCallback(
    (node: HTMLDivElement | null): void => {
      registerBrowserOverlaySlotViewport(browserTab.id, node)
    },
    [browserTab.id]
  )
  const anchorName = groupId !== undefined ? tabGroupBodyAnchorName(groupId) : undefined
  const browserPageIds =
    browserTab.pageIds && browserTab.pageIds.length > 0
      ? browserTab.pageIds
      : [browserTab.activePageId ?? browserTab.id]
  const needsGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const isMountAdmitted = useAnyBrowserPageMountAdmission(browserPageIds)
  const isPaintable = isActive || needsGuestPaint || isMountAdmitted
  // Anchor changes move tabs without reparenting guests; unassigned orphans stay hidden.
  const style: React.CSSProperties = useMemo(
    () =>
      anchorName
        ? {
            position: 'absolute',
            positionAnchor: anchorName,
            top: `anchor(${anchorName} top)`,
            left: `anchor(${anchorName} left)`,
            width: `anchor-size(${anchorName} width)`,
            height: `anchor-size(${anchorName} height)`,
            display: isPaintable ? 'flex' : 'none',
            pointerEvents: isActive ? 'auto' : 'none',
            opacity: isActive ? 1 : 0
          }
        : {
            position: 'absolute',
            top: 0,
            left: 0,
            width: 0,
            height: 0,
            display: 'none',
            pointerEvents: 'none'
          },
    [anchorName, isActive, isPaintable]
  )
  const handleFocus = useCallback(() => {
    if (groupId !== undefined && onFocusOwningGroup) {
      onFocusOwningGroup(groupId)
    }
  }, [groupId, onFocusOwningGroup])

  return (
    <div
      style={style}
      className="relative flex min-h-0 flex-1 flex-col"
      data-browser-overlay-tab-id={browserTab.id}
      onPointerDown={viewProjection ? undefined : handleFocus}
      onPointerDownCapture={viewProjection ? handleFocus : undefined}
      onFocusCapture={handleFocus}
    >
      <div ref={setSlotViewportRef} className="absolute inset-0 flex min-h-0 flex-col" />
      <DeferredBrowserContent mountEligible={isPaintable} retainMounted={isWorktreeActive}>
        <BrowserPane
          browserTab={browserTab}
          isWorktreeActive={isWorktreeActive}
          isActive={isActive}
          chromeShortcutScope={chromeShortcutScope}
        />
      </DeferredBrowserContent>
    </div>
  )
})

// Memoize the layer against unrelated parent props; focused-split state comes from its own selector.
const BrowserPaneOverlayLayer = memo(function BrowserPaneOverlayLayer({
  worktreeId,
  isWorktreeActive,
  isWorktreeFocused = isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
  isWorktreeFocused?: boolean
}): React.JSX.Element {
  const viewProjection = useWorkspaceViewProjection()
  const { browserTabs, unifiedTabs, groups, focusedGroupId } = useAppStore(
    useShallow((state) => ({
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS,
      // Why: the focused split within this worktree; gates the browser Find shortcut so a focused terminal in the same split keeps Cmd/Ctrl+F (#11348).
      focusedGroupId: state.activeGroupIdByWorktree[worktreeId]
    }))
  )
  const focusGroup = useAppStore((state) => state.focusGroup)
  const isFloatingWorkspace = isFloatingWorkspaceId(worktreeId)
  const knownFocusedGroupId = useMemo(
    () =>
      focusedGroupId !== undefined && groups.some((group) => group.id === focusedGroupId)
        ? focusedGroupId
        : undefined,
    [focusedGroupId, groups]
  )

  // Why: stable identity so BrowserOverlaySlot's memo holds; groupId is passed at call time so one callback serves every slot.
  const focusOwningGroup = useCallback(
    (groupId: string) => {
      if (!focusWorkspaceViewAnchor(viewProjection, groupId)) {
        focusGroup(worktreeId, groupId)
      }
    },
    [focusGroup, worktreeId, viewProjection]
  )

  // Why: build this lookup outside the zustand selector — a fresh object inside it would break useShallow equality and re-render on every unrelated mutation.
  const groupActiveTabById = useMemo(() => {
    const lookup: Record<string, string | null | undefined> = {}
    for (const group of groups) {
      lookup[group.id] = group.activeTabId
    }
    return lookup
  }, [groups])

  // Transient mid-move tabs may have no owning group; keep them as hidden orphans.
  const assignments = useMemo(() => {
    const entries = new Map<string, BrowserOverlayAssignment>()
    for (const tab of unifiedTabs) {
      if (tab.contentType !== 'browser') {
        continue
      }
      entries.set(tab.entityId, {
        groupId: tab.groupId,
        isActiveInGroup: groupActiveTabById[tab.groupId] === tab.id
      })
    }
    return entries
  }, [groupActiveTabById, unifiedTabs])

  // Why: a click into a page is a press in another WebContents; the slot's own pointer and focus
  // handlers never see it, so its split stayed inactive (#22144). Main reports the press instead.
  useEffect(() => {
    if (!isWorktreeActive) {
      return
    }
    return window.api.ui.onBrowserPagePointerDown(({ browserPageId }) => {
      const state = useAppStore.getState()
      const owner = resolveBrowserWorkspaceOwner(state, browserPageId, worktreeId)
      const tab = owner
        ? state.unifiedTabsByWorktree[worktreeId]?.find(
            (tab) => tab.contentType === 'browser' && tab.entityId === owner.workspaceId
          )
        : undefined
      const placement = viewProjection?.find((item) => item.tab.id === tab?.id && item.visible)
      const groupId = viewProjection
        ? placement
          ? workspaceViewAnchorId(placement.panel.id)
          : undefined
        : tab?.groupId
      if (groupId) {
        focusOwningGroup(groupId)
      }
    })
  }, [focusOwningGroup, isWorktreeActive, worktreeId, viewProjection])

  return (
    <>
      {browserTabs.map((browserTab) => {
        const assignment = assignments.get(browserTab.id)
        const placement = viewProjection?.find(
          (p) => p.tab.contentType === 'browser' && p.tab.entityId === browserTab.id
        )
        const isActive = Boolean(
          isWorktreeActive && (viewProjection ? placement?.visible : assignment?.isActiveInGroup)
        )
        const chromeShortcutScope = resolveBrowserChromeShortcutScope({
          isActive,
          isWorktreeFocused:
            isWorktreeFocused && (viewProjection ? placement?.focused === true : true),
          isFloatingWorkspace,
          focusedGroupId: knownFocusedGroupId,
          groupId: assignment?.groupId
        })
        return (
          <BrowserOverlaySlot
            key={browserTab.id}
            browserTab={browserTab}
            isWorktreeActive={isWorktreeActive}
            groupId={
              viewProjection
                ? placement
                  ? workspaceViewAnchorId(placement.panel.id)
                  : undefined
                : assignment?.groupId
            }
            isActive={isActive}
            chromeShortcutScope={chromeShortcutScope}
            onFocusOwningGroup={focusOwningGroup}
          />
        )
      })}
      {/* Render last so this tabless placeholder paints above the group’s unchanged active guest. */}
      <ClientHostedBrowserRowOverlaySlot
        worktreeId={worktreeId}
        groups={groups}
        isWorktreeActive={isWorktreeActive && !viewProjection}
      />
    </>
  )
})

function ClientHostedBrowserRowOverlaySlot({
  worktreeId,
  groups,
  isWorktreeActive
}: {
  worktreeId: string
  groups: readonly TabGroup[]
  isWorktreeActive: boolean
}): React.JSX.Element | null {
  const rows = useClientHostedBrowserRows(worktreeId)
  const selection = useClientHostedBrowserRowSelection()
  const liveSelection =
    selection?.worktreeId === worktreeId && isClientHostedBrowserRowSelectionLive(selection, groups)
      ? selection
      : null
  const selectedRow = liveSelection
    ? rows.find((row) => row.browserPageId === liveSelection.browserPageId)
    : undefined
  const anchorName =
    selectedRow && liveSelection ? tabGroupBodyAnchorName(liveSelection.groupId) : undefined
  const style = useMemo<React.CSSProperties | null>(
    () =>
      anchorName
        ? {
            position: 'absolute',
            positionAnchor: anchorName,
            top: `anchor(${anchorName} top)`,
            left: `anchor(${anchorName} left)`,
            width: `anchor-size(${anchorName} width)`,
            height: `anchor-size(${anchorName} height)`
          }
        : null,
    [anchorName]
  )
  if (!selectedRow || !style || !isWorktreeActive) {
    return null
  }
  return (
    <div
      style={style}
      className="flex min-h-0 flex-col"
      data-client-hosted-browser-host-row-pane={selectedRow.browserPageId}
    >
      <ClientHostedBrowserHostRowPane row={selectedRow} />
    </div>
  )
}

export const RetainedBrowserPaneOverlayLayer = memo(function RetainedBrowserPaneOverlayLayer({
  worktreeId,
  isWorktreeActive,
  isWorktreeFocused = isWorktreeActive,
  mountEligible
}: {
  worktreeId: string
  isWorktreeActive: boolean
  /** False for a visible grid view member: its browsers paint but must not own chrome chords. */
  isWorktreeFocused?: boolean
  mountEligible: boolean
}): React.JSX.Element | null {
  return (
    <DeferredBrowserContent mountEligible={mountEligible}>
      <BrowserPaneOverlayLayer
        worktreeId={worktreeId}
        isWorktreeActive={isWorktreeActive}
        isWorktreeFocused={isWorktreeFocused}
      />
    </DeferredBrowserContent>
  )
})

export default BrowserPaneOverlayLayer
