import { memo, useCallback, useMemo } from 'react'
import { registerBrowserOverlaySlotViewport } from './browser-page-viewport'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { BrowserTab as BrowserTabState, Tab, TabGroup } from '../../../../shared/types'
import BrowserPane from './BrowserPane'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { useBrowserAutomationVisibilityForAny } from './browser-automation-visibility'
import { useBrowserMobileDriverForAny } from '@/lib/pane-manager/browser-mobile-driver-state'

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
  // Why: undefined = orphan tab (in browserTabs but not referenced by any group's unified-tab list); the fallback branch keeps these hidden.
  groupId: string | undefined
  isActive: boolean
  // Why: overlay is a sibling of the group layout, so pane focus doesn't bubble to TabGroupPanel; re-sync it here or split-view clicks leave activeGroupIdByWorktree stale.
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  isWorktreeActive: boolean
}

// Why: memoize each slot so unrelated worktree mutations don't cascade a re-render into every BrowserPane subtree.
const BrowserOverlaySlot = memo(function BrowserOverlaySlot({
  browserTab,
  groupId,
  isActive,
  onFocusOwningGroup,
  isWorktreeActive
}: BrowserOverlaySlotProps): React.JSX.Element {
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
  const automationVisible = useBrowserAutomationVisibilityForAny(browserPageIds)
  const mobileDriven = useBrowserMobileDriverForAny(browserPageIds)
  const isPaintable = isActive || automationVisible || mobileDriven
  // Why: hidden worktrees keep lightweight overlay slots, but park their webviews unless a remote controller needs the guest.
  const shouldMountPane = isWorktreeActive || automationVisible || mobileDriven
  // Why: CSS anchor positioning pins the overlay to its owning group's body — a tab move only swaps positionAnchor, no measurement/state.
  // Orphan branch (no anchorName) stays display:none until the tab is reassigned or destroyed.
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
      onPointerDown={handleFocus}
      onFocusCapture={handleFocus}
    >
      <div ref={setSlotViewportRef} className="absolute inset-0 flex min-h-0 flex-col" />
      {/* Why: hidden worktrees park the heavy pane subtree; visible ones keep stable slots so reparenting can't destroy the webview guest. */}
      {shouldMountPane ? <BrowserPane browserTab={browserTab} isActive={isActive} /> : null}
    </div>
  )
})

// Why: memoize so parent re-renders on props this layer doesn't consume (e.g. focusedGroupId) don't rerun its selector or assignments mapping.
const BrowserPaneOverlayLayer = memo(function BrowserPaneOverlayLayer({
  worktreeId,
  isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
}): React.JSX.Element {
  const { browserTabs, unifiedTabs, groups } = useAppStore(
    useShallow((state) => ({
      browserTabs: state.browserTabsByWorktree[worktreeId] ?? EMPTY_BROWSER_TABS,
      unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_UNIFIED_TABS,
      groups: state.groupsByWorktree[worktreeId] ?? EMPTY_GROUPS
    }))
  )
  const focusGroup = useAppStore((state) => state.focusGroup)

  // Why: stable identity so BrowserOverlaySlot's memo holds; groupId is passed at call time so one callback serves every slot.
  const focusOwningGroup = useCallback(
    (groupId: string) => focusGroup(worktreeId, groupId),
    [focusGroup, worktreeId]
  )

  // Why: build this lookup outside the zustand selector — a fresh object inside it would break useShallow equality and re-render on every unrelated mutation.
  const groupActiveTabById = useMemo(() => {
    const lookup: Record<string, string | null | undefined> = {}
    for (const group of groups) {
      lookup[group.id] = group.activeTabId
    }
    return lookup
  }, [groups])

  // Map each browser tab to its owning group; tabs not in any group's unified-tab list are transient mid-move "orphans", not a steady state.
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

  return (
    <>
      {browserTabs.map((browserTab) => {
        const assignment = assignments.get(browserTab.id)
        const isActive = Boolean(isWorktreeActive && assignment && assignment.isActiveInGroup)
        return (
          <BrowserOverlaySlot
            key={browserTab.id}
            browserTab={browserTab}
            groupId={assignment?.groupId}
            isActive={isActive}
            onFocusOwningGroup={focusOwningGroup}
            isWorktreeActive={isWorktreeActive}
          />
        )
      })}
    </>
  )
})

export default BrowserPaneOverlayLayer
