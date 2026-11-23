import { useCallback, useEffect, useRef } from 'react'
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

export function NotchPanel({ snapshot }: { snapshot: NotchSnapshot }): React.JSX.Element | null {
  const { layout, metrics, rows, expanded } = snapshot

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }, [])
  useEffect(() => cancelClose, [cancelClose])

  const toggle = useCallback(() => {
    cancelClose()
    window.api.notch?.toggleExpanded()
  }, [cancelClose])

  const enterPainted = useCallback(() => {
    cancelClose()
    window.api.notch?.setInteractive(true)
  }, [cancelClose])
  const enterBar = useCallback(() => {
    enterPainted()
    if (rows.length > 0) {
      window.api.notch?.setExpanded(true)
    }
  }, [enterPainted, rows.length])
  const leavePainted = useCallback(() => {
    window.api.notch?.setInteractive(false)
    cancelClose()
    // Bridge the gap between the bar and the list without leaving an unattended panel open.
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      window.api.notch?.setExpanded(false)
    }, 160)
  }, [cancelClose])

  useEffect(() => {
    if (rows.length === 0) {
      cancelClose()
      window.api.notch?.setInteractive(false)
    }
  }, [cancelClose, rows.length])

  if (rows.length === 0) {
    return null
  }

  return (
    <div
      // pointer-events:none so the gutters are inert to the DOM as well as to the OS.
      className="pointer-events-none h-full w-full overflow-hidden"
      style={{ paddingTop: metrics.topGap }}
    >
      <div className="flex flex-col">
        <div className="flex" style={{ paddingLeft: layout.leadingOffset }}>
          <button
            type="button"
            onClick={toggle}
            onMouseEnter={enterBar}
            onMouseLeave={leavePainted}
            className="pointer-events-auto cursor-default focus-visible:outline-none"
            aria-expanded={expanded}
          >
            <NotchBar snapshot={snapshot} />
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
