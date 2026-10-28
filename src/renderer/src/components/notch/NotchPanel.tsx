import { useCallback } from 'react'
import { NotchBar } from './NotchBar'
import { NotchSessionList } from './NotchSessionList'
import type { NotchRow, NotchSnapshot } from '../../../../shared/notch/notch-snapshot'

function activateRow(row: NotchRow): void {
  if (!row.worktreeId || !row.tabId) {
    return
  }
  window.api.notch.focusPane({
    repoId: row.repoId ?? row.worktreeId,
    worktreeId: row.worktreeId,
    tabId: row.tabId,
    leafId: row.leafId
  })
  // Picking a row is the same "I've seen it" signal as visiting the pane.
  window.api.notch.acknowledgePanes([row.paneKey])
  window.api.notch.setExpanded(false)
}

/**
 * One view tree for both states.
 *
 * Why not two: the bar keeps its identity across the transition — collapsed, the window is the
 * bar, so the bar sits at x=0; expanded, the window is the whole panel, so the bar slides to
 * `layout.leadingOffset` to stay over the physical cutout. Re-mounting would restart the
 * spinner.
 *
 * Expansion is click-only. Hover-to-open was removed: a dwell timer that opens a panel under
 * the pointer is easy to trigger by accident on a surface you cross to reach the menu bar.
 */
export function NotchPanel({ snapshot }: { snapshot: NotchSnapshot }): React.JSX.Element {
  const { layout, metrics, rows, expanded } = snapshot

  const toggle = useCallback(() => {
    window.api.notch.setExpanded(!expanded)
  }, [expanded])

  // Why these stay even without hover expansion: the window ignores the mouse by default so
  // its transparent gutters can't swallow clicks on the menu bar underneath. Painted regions
  // opt in on enter and out on leave — without this the bar would not be clickable at all.
  const enterPainted = useCallback(() => window.api.notch.setInteractive(true), [])
  const leavePainted = useCallback(() => window.api.notch.setInteractive(false), [])

  return (
    <div
      // pointer-events:none so the gutters are inert to the DOM as well as to the OS.
      className="pointer-events-none h-screen w-screen overflow-hidden"
      style={{ paddingTop: metrics.topGap }}
    >
      <div className="flex flex-col">
        <div
          className="flex"
          // Collapsed the window is exactly the bar; expanded it is the full panel, so the bar
          // shifts to stay pinned to the cutout.
          style={{ paddingLeft: expanded ? layout.leadingOffset : 0 }}
        >
          <button
            type="button"
            onClick={toggle}
            onMouseEnter={enterPainted}
            onMouseLeave={leavePainted}
            className="pointer-events-auto cursor-default focus-visible:outline-none"
            aria-expanded={expanded}
          >
            <NotchBar snapshot={snapshot} squareBottom={expanded} />
          </button>
        </div>

        {expanded && rows.length > 0 ? (
          <div
            className="pointer-events-auto mt-1 overflow-hidden bg-black py-1 text-white"
            onMouseEnter={enterPainted}
            onMouseLeave={leavePainted}
            style={{
              marginLeft: metrics.expandedContentSideInset,
              marginRight: metrics.expandedContentSideInset,
              borderRadius: metrics.bottomCornerRadius
            }}
          >
            <NotchSessionList rows={rows} onActivate={activateRow} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
