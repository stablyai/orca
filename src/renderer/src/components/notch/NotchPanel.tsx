import { useCallback } from 'react'
import { NotchBar } from './NotchBar'
import { NotchSessionList } from './NotchSessionList'
import type { NotchRow, NotchSnapshot } from '../../../../shared/notch/notch-snapshot'

function activateRow(row: NotchRow): void {
  if (!row.worktreeId || !row.tabId) {
    return
  }
  window.api.notch?.focusPane(row.paneKey)
  window.api.notch?.setExpanded(false)
}

export function NotchPanel({ snapshot }: { snapshot: NotchSnapshot }): React.JSX.Element {
  const { layout, metrics, rows, expanded } = snapshot

  const toggle = useCallback(() => {
    window.api.notch?.setExpanded(!expanded)
  }, [expanded])

  const enterPainted = useCallback(() => window.api.notch?.setInteractive(true), [])
  const leavePainted = useCallback(() => window.api.notch?.setInteractive(false), [])

  return (
    <div
      // pointer-events:none so the gutters are inert to the DOM as well as to the OS.
      className="pointer-events-none h-full w-full overflow-hidden"
      style={{ paddingTop: metrics.topGap }}
    >
      <div className="flex flex-col">
        <div className="flex" style={{ paddingLeft: expanded ? layout.leadingOffset : 0 }}>
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
            className="pointer-events-auto mt-1 overflow-hidden rounded-xl bg-popover py-1 text-popover-foreground"
            onMouseEnter={enterPainted}
            onMouseLeave={leavePainted}
            style={{
              marginLeft: metrics.expandedContentSideInset,
              marginRight: metrics.expandedContentSideInset
            }}
          >
            <NotchSessionList rows={rows} onActivate={activateRow} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
