import { memo, useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { registerBrowserOverlaySlotViewport } from '../host-guest/browser-page-viewport'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../store'
import type { BrowserTab as BrowserTabState } from '../../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import BrowserPane from './browser-workspace-pane'
import type { BrowserChromeShortcutScope } from '../describe-page/browser-page-types'
import { tabGroupBodyAnchorName } from '../../tab-group/tab-group-body-anchor'
import { useBrowserGuestPaintRetention } from '../host-guest/browser-guest-paint-retention'
import {
  isClientHostedBrowserRowSelectionLive,
  useClientHostedBrowserRowSelection,
  useClientHostedBrowserRows
} from '@/lib/pane-manager/client-hosted-browser-row-state'
import { ClientHostedBrowserHostRowPane } from '../client-hosted-browser-host-row-pane'

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
  chromeShortcutScope: BrowserChromeShortcutScope
  // Why: overlay is a sibling of the group layout, so pane focus doesn't bubble to TabGroupPanel; re-sync it here or split-view clicks leave activeGroupIdByWorktree stale.
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  isWorktreeActive: boolean
}

// Why: memoize each slot so unrelated worktree mutations don't cascade a re-render into every BrowserPane subtree.
const BrowserOverlaySlot = memo(function BrowserOverlaySlot({
  browserTab,
  groupId,
  isActive,
  chromeShortcutScope,
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
  const needsGuestPaint = useBrowserGuestPaintRetention(browserPageIds)
  const isPaintable = isActive || needsGuestPaint
  // Why: hidden worktrees keep lightweight overlay slots, but park their webviews unless a remote controller or viewer needs the guest.
  const shouldMountPane = isWorktreeActive || needsGuestPaint
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
      {shouldMountPane ? (
        <BrowserPane
          browserTab={browserTab}
          isActive={isActive}
          chromeShortcutScope={chromeShortcutScope}
        />
      ) : null}
    </div>
  )
})

// Why: memoize so parent re-renders on props this layer doesn't consume don't rerun its selector or assignments mapping (focused-split state comes from the store selector below, not props).
const BrowserPaneOverlayLayer = memo(function BrowserPaneOverlayLayer({
  worktreeId,
  isWorktreeActive
}: {
  worktreeId: string
  isWorktreeActive: boolean
}): React.JSX.Element {
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
  const knownFocusedGroupId = useMemo(
    () =>
      focusedGroupId !== undefined && groups.some((group) => group.id === focusedGroupId)
        ? focusedGroupId
        : undefined,
    [focusedGroupId, groups]
  )

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
        const chromeShortcutScope: BrowserChromeShortcutScope = !isActive
          ? 'inactive'
          : knownFocusedGroupId === undefined
            ? 'owned-target'
            : assignment?.groupId === knownFocusedGroupId
              ? 'focused'
              : 'inactive'
        return (
          <BrowserOverlaySlot
            key={browserTab.id}
            browserTab={browserTab}
            groupId={assignment?.groupId}
            isActive={isActive}
            chromeShortcutScope={chromeShortcutScope}
            onFocusOwningGroup={focusOwningGroup}
            isWorktreeActive={isWorktreeActive}
          />
        )
      })}
      {/* Why: last in DOM order so the placeholder paints over whichever guest the group was
          showing — the group's own active tab is untouched, since a client-hosted row owns no
          unified tab to become active. */}
      <ClientHostedBrowserRowOverlaySlot
        worktreeId={worktreeId}
        groups={groups}
        isWorktreeActive={isWorktreeActive}
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
  mountEligible
}: {
  worktreeId: string
  isWorktreeActive: boolean
  mountEligible: boolean
}): React.JSX.Element | null {
  const [hasCommittedMount, setHasCommittedMount] = useState(false)
  // Why: commit the latch with the persistent slot DOM so discarded renders cannot retain a guest host.
  useLayoutEffect(() => {
    if (mountEligible && !hasCommittedMount) {
      setHasCommittedMount(true)
    }
  }, [hasCommittedMount, mountEligible])
  if (!mountEligible && !hasCommittedMount) {
    return null
  }
  return <BrowserPaneOverlayLayer worktreeId={worktreeId} isWorktreeActive={isWorktreeActive} />
})

export default BrowserPaneOverlayLayer
