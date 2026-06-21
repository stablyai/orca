import { memo, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { BrowserTab as BrowserTabState, Tab, TabGroup } from '../../../../shared/types'
import BrowserPane from './BrowserPane'
import { tabGroupBodyAnchorName } from '../tab-group/tab-group-body-anchor'
import { useBrowserAutomationVisibilityForAny } from './browser-automation-visibility'
import { useBrowserMobileDriverForAny } from '@/lib/pane-manager/browser-mobile-driver-state'

// Why: Electron `<webview>` destroys its guest contents whenever its DOM
// parent changes. Rendering paintable BrowserPanes at the worktree level
// (keyed only by browserTab.id) means moving an active tab between groups
// never reparents the webview — it only updates the overlay's CSS
// `position-anchor` so the pane tracks the new owning group's body via
// native CSS anchor positioning.

type BrowserOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

type BrowserOverlaySlotProps = {
  browserTab: BrowserTabState
  // Why: `undefined` means this browser tab has no owning group (an "orphan" —
  // present in `browserTabs` but not referenced by any group's unified-tab
  // list). See the fallback branch below for why these slots remain hidden.
  groupId: string | undefined
  isActive: boolean
  // Why: the legacy architecture rendered BrowserPane inside TabGroupPanel, so
  // React events from the pane bubbled through TabGroupPanel's
  // `onPointerDown={focusGroup}` / `onFocusCapture={focusGroup}`. Now that
  // BrowserPane lives in a worktree-level overlay that is a SIBLING of
  // TabGroupSplitLayout, those events no longer reach TabGroupPanel — so in
  // split view, clicking the browser chrome would leave
  // `activeGroupIdByWorktree` stale. The overlay slot re-implements that
  // focus sync directly, targeting the owning group.
  onFocusOwningGroup: ((groupId: string) => void) | undefined
  isWorktreeActive: boolean
}

// Why: each overlay slot is memoized so its BrowserPane subtree only re-renders
// when its own assignment, active state, or worktree visibility changes.
// Without this, unrelated worktree mutations (terminal keystrokes, editor
// updates, etc.) would cascade into every BrowserPane.
const BrowserOverlaySlot = memo(function BrowserOverlaySlot({
  browserTab,
  groupId,
  isActive,
  onFocusOwningGroup,
  isWorktreeActive
}: BrowserOverlaySlotProps): React.JSX.Element {
  const anchorName = groupId !== undefined ? tabGroupBodyAnchorName(groupId) : undefined
  const browserPageIds =
    browserTab.pageIds && browserTab.pageIds.length > 0
      ? browserTab.pageIds
      : [browserTab.activePageId ?? browserTab.id]
  const automationVisible = useBrowserAutomationVisibilityForAny(browserPageIds)
  const mobileDriven = useBrowserMobileDriverForAny(browserPageIds)
  const isPaintable = isActive || automationVisible || mobileDriven
  // Why: hidden worktrees keep lightweight overlay slots mounted, but their
  // Electron webviews must park unless a remote controller needs the guest.
  const shouldMountPane = isWorktreeActive || automationVisible || mobileDriven
  // Why: each overlay pins itself to the owning TabGroupPanel's body via CSS
  // anchor positioning. `anchor()` resolves top/left relative to the viewport,
  // and the overlay's own `position: absolute` inside a positioned ancestor
  // (the worktree surface div) converts those to the surface's coordinate
  // space. `anchor-size()` fills the slot exactly. When the tab moves between
  // groups, only `positionAnchor` changes and the browser relayouts on its
  // own — no measurement or state updates.
  //
  // The orphan branch (no anchorName) stays display:none until the tab is
  // reassigned (e.g. mid-move) or explicitly destroyed via `closeBrowserTab`.
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
      data-browser-overlay-tab-id={browserTab.id}
      onPointerDown={handleFocus}
      onFocusCapture={handleFocus}
    >
      {/* Why: moving an Electron webview between DOM parents destroys the guest
          document in some Electron builds. Visible worktree browsers stay in
          stable overlay slots; hidden worktrees park the heavy pane subtree. */}
      {shouldMountPane ? <BrowserPane browserTab={browserTab} isActive={isActive} /> : null}
    </div>
  )
})

// Why: memoize so parent re-renders (e.g. `WorktreeSplitSurface` re-rendering
// because `focusedGroupId` changed — a prop this component doesn't consume)
// don't rerun the overlay's zustand selector or the assignments mapping.
// The child `BrowserOverlaySlot` is already memoized, but skipping this layer
// entirely when its own props are unchanged keeps the fast path fastest.
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

  // Why: stable callback identity so BrowserOverlaySlot's memo isn't broken by
  // a fresh function reference every render. The group id is passed in at call
  // time so the same callback serves every slot regardless of which group owns
  // that tab.
  const focusOwningGroup = useCallback(
    (groupId: string) => focusGroup(worktreeId, groupId),
    [focusGroup, worktreeId]
  )

  // Why: derive the lookup OUTSIDE the zustand selector so shallow equality
  // holds across unrelated store mutations. If we built the object inside the
  // selector, every store change would create a new reference and useShallow
  // would never find equality — the overlay would re-render on every
  // keystroke in an unrelated terminal.
  const groupActiveTabById = useMemo(() => {
    const lookup: Record<string, string | null | undefined> = {}
    for (const group of groups) {
      lookup[group.id] = group.activeTabId
    }
    return lookup
  }, [groups])

  // Map each browser tab to the group that owns it (if any) and whether it's
  // the currently active tab in that group. Tabs that exist in `browserTabs`
  // but are not referenced by any group's unified-tab list are "orphans". In
  // normal flows this is a transient mid-move state, not a steady state:
  // closing a tab calls `closeBrowserTab` which removes it from `browserTabs`
  // (and `destroyPersistentWebview` tears down the guest), and "Close Group"
  // closes each browser tab before collapsing the group shell — no
  // follow-to-sibling migration happens.
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
