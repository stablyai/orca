import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { BrowserTab as BrowserTabState, Tab, TabGroup } from '../../../../shared/types'
import BrowserPane from './BrowserPane'
import { browserSlotAnchorName } from './browser-pane-slots'

// Why: Electron `<webview>` destroys its guest contents whenever its DOM
// parent changes. Rendering one BrowserPane per tab at the worktree level
// (keyed only by browserTab.id) means moving a tab between groups never
// remounts the pane and never reparents the webview — it only updates the
// overlay's CSS `position-anchor` so the pane tracks the new owning group's
// body via native CSS anchor positioning.

type BrowserOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

const EMPTY_BROWSER_TABS: readonly BrowserTabState[] = []
const EMPTY_UNIFIED_TABS: readonly Tab[] = []
const EMPTY_GROUPS: readonly TabGroup[] = []

export default function BrowserPaneOverlayLayer({
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
  // but are not referenced by any group's unified-tab list are "orphans": we
  // still render the pane (at 0×0 display:none — see fallback branch below)
  // so the `<webview>` survives until the tab is either reassigned or
  // explicitly destroyed. In normal flows this is a transient mid-move
  // state, not a steady state: closing a tab calls `closeBrowserTab` which
  // removes it from `browserTabs` (and `destroyPersistentWebview` tears
  // down the guest), and "Close Group" closes each browser tab before
  // collapsing the group shell — no follow-to-sibling migration happens.
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
        // Why: each overlay pins itself to the owning TabGroupPanel's body
        // via CSS anchor positioning. `anchor()` resolves top/left relative
        // to the viewport, and the overlay's own `position: absolute`
        // inside a positioned ancestor (the worktree surface div) converts
        // those to the surface's coordinate space. `anchor-size()` fills
        // the slot exactly. When the tab moves between groups, only
        // `positionAnchor` changes and the browser relayouts on its own —
        // no measurement or state updates.
        const anchorName = assignment ? browserSlotAnchorName(assignment.groupId) : undefined
        const style: React.CSSProperties = assignment
          ? {
              position: 'absolute',
              positionAnchor: anchorName,
              top: `anchor(${anchorName} top)`,
              left: `anchor(${anchorName} left)`,
              width: `anchor-size(${anchorName} width)`,
              height: `anchor-size(${anchorName} height)`,
              display: isActive ? 'flex' : 'none',
              pointerEvents: isActive ? 'auto' : 'none'
            }
          : {
              // Why: orphan tabs (present in `browserTabs` but not in any
              // group's unified-tab list) stay mounted at 0×0 display:none
              // so the DOM parent stays stable and the `<webview>` guest
              // survives until the tab is reassigned (e.g. mid-move) or
              // explicitly destroyed via `closeBrowserTab`.
              position: 'absolute',
              top: 0,
              left: 0,
              width: 0,
              height: 0,
              display: 'none',
              pointerEvents: 'none'
            }
        return (
          <div key={browserTab.id} style={style} data-browser-overlay-tab-id={browserTab.id}>
            <BrowserPane browserTab={browserTab} isActive={isActive} />
          </div>
        )
      })}
    </>
  )
}
