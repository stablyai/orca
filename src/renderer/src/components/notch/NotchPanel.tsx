import { useCallback } from 'react'
import { NotchBar } from './NotchBar'
import { NotchSessionList } from './NotchSessionList'
import { useNotchExpansion } from './useNotchExpansion'
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
 * spinner and drop hover mid-gesture.
 */
export function NotchPanel({ snapshot }: { snapshot: NotchSnapshot }): React.JSX.Element {
  const { layout, metrics, rows, expanded } = snapshot

  const setExpanded = useCallback((next: boolean) => {
    window.api.notch.setExpanded(next)
  }, [])
  const handlers = useNotchExpansion(expanded, setExpanded)

  // Why: the window ignores the mouse by default so its transparent gutters can't swallow
  // clicks on the menu bar underneath. Painted regions opt in on enter and out on leave —
  // hover/click only ever work where something is actually drawn.
  const enterPainted = useCallback(
    (event: React.MouseEvent) => {
      window.api.notch.setInteractive(true)
      handlers.onPointerEnter(event)
    },
    [handlers]
  )
  const leavePainted = useCallback(() => {
    window.api.notch.setInteractive(false)
    handlers.onPointerLeave()
  }, [handlers])

  return (
    <div
      // pointer-events:none so the gutters are inert to the DOM as well as to the OS.
      className="pointer-events-none h-screen w-screen overflow-hidden"
      style={{ paddingTop: metrics.topGap }}
      onMouseMove={handlers.onPointerMove}
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
            onClick={handlers.onClick}
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
            className="pointer-events-auto mt-1.5 overflow-hidden bg-black py-1.5 text-white"
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
