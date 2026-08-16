import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { registerBrowserOverlaySlotViewport } from './browser-page-viewport'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import BrowserPane, { type BrowserFindShortcutScope } from './BrowserPane'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { useOverlaySlotGeometry } from '../tab-group/use-overlay-slot-geometry'
import { useBrowserAutomationVisibilityForAny } from './browser-automation-visibility'
import { useBrowserMobileDriverForAny } from '@/lib/pane-manager/browser-mobile-driver-state'

const HAS_CSS_ANCHOR_POSITIONING =
  typeof CSS !== 'undefined' &&
  CSS.supports('position-anchor', '--orca-browser-overlay-probe') &&
  CSS.supports('top', 'anchor(--orca-browser-overlay-probe top)') &&
  CSS.supports('width', 'anchor-size(--orca-browser-overlay-probe width)')

function shouldUseCssAnchorPositioning(): boolean {
  return (
    HAS_CSS_ANCHOR_POSITIONING &&
    (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ !== true
  )
}

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
  findShortcutScope: BrowserFindShortcutScope
  // Why: overlay is a sibling of the group layout, so pane focus doesn't bubble to TabGroupPanel; re-sync it here or split-view clicks leave activeGroupIdByWorktree stale.
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  isWorktreeActive: boolean
}

// Why: memoize each slot so unrelated worktree mutations don't cascade a re-render into every BrowserPane subtree.
const BrowserOverlaySlot = memo(function BrowserOverlaySlot({
  browserTab,
  groupId,
  isActive,
  findShortcutScope,
  onFocusOwningGroup,
  isWorktreeActive
}: BrowserOverlaySlotProps): React.JSX.Element {
  const overlayRef = useRef<HTMLDivElement | null>(null)
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
  const { measuredRect, useCssAnchors } = useOverlaySlotGeometry({
    overlayRef,
    groupId,
    worktreeId: browserTab.worktreeId,
    cssAnchorsSupported: shouldUseCssAnchorPositioning(),
    isVisible: isPaintable
  })
  // Why: CSS anchors are preferred; after a column snap they can leave the
  // webview covering tab chrome, so measured geometry is the recovery path.
  const style: React.CSSProperties = useMemo(
    () =>
      anchorName && useCssAnchors
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
        : anchorName
          ? {
              position: 'absolute',
              top: measuredRect?.top ?? 32,
              left: measuredRect?.left ?? 0,
              width: measuredRect?.width ?? '100%',
              height: measuredRect?.height ?? 'calc(100% - 32px)',
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
    [anchorName, isActive, isPaintable, measuredRect, useCssAnchors]
  )
  const handleFocus = useCallback(() => {
    if (groupId !== undefined && onFocusOwningGroup) {
      onFocusOwningGroup(groupId)
    }
  }, [groupId, onFocusOwningGroup])

  return (
    <div
      ref={overlayRef}
      style={style}
      className="relative flex min-h-0 flex-1 flex-col"
      data-browser-overlay-tab-id={browserTab.id}
      data-overlay-geometry={useCssAnchors ? 'anchor' : 'measured'}
      onPointerDown={handleFocus}
      onFocusCapture={handleFocus}
    >
      <div ref={setSlotViewportRef} className="absolute inset-0 flex min-h-0 flex-col" />
      {/* Why: hidden worktrees park the heavy pane subtree; visible ones keep stable slots so reparenting can't destroy the webview guest. */}
      {shouldMountPane ? (
        <BrowserPane
          browserTab={browserTab}
          isActive={isActive}
          findShortcutScope={findShortcutScope}
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
        const findShortcutScope: BrowserFindShortcutScope = !isActive
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
            findShortcutScope={findShortcutScope}
            onFocusOwningGroup={focusOwningGroup}
            isWorktreeActive={isWorktreeActive}
          />
        )
      })}
    </>
  )
})

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
