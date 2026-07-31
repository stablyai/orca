import { useEffect, useRef, useState } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import {
  approximateTerminalCellGeometry,
  clientPointToTerminalCell,
  resolveTerminalCellGeometry,
  type TerminalCellGeometry
} from '@/lib/terminal-cell-geometry'
import { assignPeerPresenceColor } from '../../../../shared/peer-presence-color'
import type {
  PeerPresenceCursor,
  PeerPresenceScroll,
  PeerPresenceSelection,
  PeerPresenceState
} from '../../../../shared/peer-presence-event'
import { RemoteTerminalPresenceOverlay } from '@/components/peer-collab/RemoteTerminalPresenceOverlay'
import { resolveTerminalHandleForPane } from './terminal-handle-copy'
import { usePeerCollabConnectedClients } from './use-peer-collab-connected-clients'

const HOST_PRESENCE_CLIENT_ID = 'host'
// Why: gates continuous cursor/scroll sends to ~60Hz without ever queuing —
// mirrors RemoteTerminalPanel's PRESENCE_SEND_THROTTLE_MS.
const PRESENCE_SEND_THROTTLE_MS = 16

/**
 * Portaled into a pane's own `.pane` container (position: relative — see
 * terminal.css) by TerminalPane, one per pane. Shows connected peers'
 * cursors/selections over the host's local terminal, and forwards the host's
 * own mouse position the same way. Absolute-positioned layer only; never
 * touches xterm's own rendering or the pty-connection input path.
 */
export function TerminalPanePresenceOverlay({
  tabId,
  pane
}: {
  tabId: string
  pane: ManagedPane
}): React.JSX.Element | null {
  const { clients: connectedClients } = usePeerCollabConnectedClients()
  const hasViewers = connectedClients.length > 0
  const settings = useAppStore((state) => state.settings)
  const [handle, setHandle] = useState<string | null>(null)
  // Why: only this pane's own subscribers should trigger presence wiring —
  // "any peer connected anywhere" would mount listeners on every open pane.
  const isWatchedByPeer =
    handle !== null &&
    connectedClients.some((client) => client.subscribedTerminals.includes(handle))
  const ownDisplayNameRef = useRef('Host')
  ownDisplayNameRef.current = settings?.peerCollabDisplayName?.trim() || 'Host'
  const [remoteParticipants, setRemoteParticipants] = useState<Map<string, PeerPresenceState>>(
    () => new Map()
  )
  const [cellMetrics, setCellMetrics] = useState({
    cellWidth: 0,
    cellHeight: 0,
    cols: pane.terminal.cols,
    rows: pane.terminal.rows,
    originLeft: 0,
    originTop: 0
  })

  useEffect(() => {
    if (!hasViewers) {
      setHandle(null)
      return
    }
    let disposed = false
    const callRuntime = window.api?.runtime?.call
    if (!callRuntime) {
      return
    }
    void resolveTerminalHandleForPane({ tabId, leafId: pane.leafId, callRuntime })
      .then((resolved) => {
        if (!disposed) {
          setHandle(resolved)
        }
      })
      .catch(() => undefined)
    return () => {
      disposed = true
    }
  }, [tabId, pane.leafId, hasViewers])

  useEffect(() => {
    if (!isWatchedByPeer || !handle) {
      setRemoteParticipants(new Map())
      return
    }
    const container = pane.container
    const terminal = pane.terminal
    let disposed = false
    let requestId: string | null = null
    let lastSendAt = 0
    let ownCursor: PeerPresenceCursor = null
    let ownSelection: PeerPresenceSelection = null
    let ownScroll: PeerPresenceScroll = { atBottom: true, scrollTop: 0 }
    // Why: mousemove needs the current cell geometry synchronously; React
    // state set via updateCellMetrics only reaches this closure on the next render.
    let localCellMetrics: TerminalCellGeometry = approximateTerminalCellGeometry(
      container,
      terminal.cols,
      terminal.rows
    )

    const updateCellMetrics = (): void => {
      localCellMetrics =
        resolveTerminalCellGeometry(terminal, container) ??
        approximateTerminalCellGeometry(container, terminal.cols, terminal.rows)
      setCellMetrics({
        cellWidth: localCellMetrics.cellWidth,
        cellHeight: localCellMetrics.cellHeight,
        cols: terminal.cols,
        rows: terminal.rows,
        originLeft: localCellMetrics.originLeft,
        originTop: localCellMetrics.originTop
      })
    }

    const sendOwnPresence = (immediate: boolean): void => {
      if (!requestId || !handle) {
        return
      }
      const now = performance.now()
      if (!immediate && now - lastSendAt < PRESENCE_SEND_THROTTLE_MS) {
        return
      }
      lastSendAt = now
      void window.api.terminalHostPresence.send({
        requestId,
        terminal: handle,
        state: {
          participant: {
            clientId: HOST_PRESENCE_CLIENT_ID,
            name: ownDisplayNameRef.current,
            color: assignPeerPresenceColor(HOST_PRESENCE_CLIENT_ID)
          },
          cursor: ownCursor,
          selection: ownSelection,
          scroll: ownScroll
        }
      })
    }

    const handleMouseMove = (mouseEvent: MouseEvent): void => {
      if (localCellMetrics.cellWidth <= 0 || localCellMetrics.cellHeight <= 0) {
        return
      }
      const rect = container.getBoundingClientRect()
      ownCursor = clientPointToTerminalCell(
        mouseEvent.clientX,
        mouseEvent.clientY,
        rect,
        localCellMetrics,
        terminal.cols,
        terminal.rows
      )
      sendOwnPresence(false)
    }
    const handleMouseLeave = (): void => {
      ownCursor = null
      sendOwnPresence(true)
    }
    container.addEventListener('mousemove', handleMouseMove)
    container.addEventListener('mouseleave', handleMouseLeave)

    const scrollDisposable = terminal.onScroll(() => {
      const buffer = terminal.buffer.active
      ownScroll = { atBottom: buffer.viewportY >= buffer.baseY, scrollTop: buffer.viewportY }
      sendOwnPresence(false)
    })
    const selectionDisposable = terminal.onSelectionChange(() => {
      const range = terminal.getSelectionPosition()
      const viewportY = terminal.buffer.active.viewportY
      ownSelection = range
        ? {
            startCol: range.start.x - 1,
            startRow: range.start.y - 1 - viewportY,
            endCol: range.end.x - 1,
            endRow: range.end.y - 1 - viewportY
          }
        : null
      sendOwnPresence(true)
    })

    const resizeObserver = new ResizeObserver(updateCellMetrics)
    resizeObserver.observe(container)
    updateCellMetrics()

    const offEvent = window.api.terminalHostPresence.onEvent(({ requestId: id, event }) => {
      if (id !== requestId || disposed) {
        return
      }
      if (event.type === 'state') {
        setRemoteParticipants((prev) => {
          const next = new Map(prev)
          next.set(event.state.participant.clientId, event.state)
          return next
        })
      } else if (event.type === 'left') {
        setRemoteParticipants((prev) => {
          if (!prev.has(event.clientId)) {
            return prev
          }
          const next = new Map(prev)
          next.delete(event.clientId)
          return next
        })
      }
    })

    void (async () => {
      const result = await window.api.terminalHostPresence.subscribe({ terminal: handle })
      if (disposed) {
        if (result.ok) {
          void window.api.terminalHostPresence.unsubscribe({ requestId: result.requestId })
        }
        return
      }
      if (result.ok) {
        requestId = result.requestId
      }
    })()

    return () => {
      disposed = true
      resizeObserver.disconnect()
      container.removeEventListener('mousemove', handleMouseMove)
      container.removeEventListener('mouseleave', handleMouseLeave)
      scrollDisposable.dispose()
      selectionDisposable.dispose()
      offEvent()
      if (requestId) {
        void window.api.terminalHostPresence.unsubscribe({ requestId })
      }
    }
  }, [isWatchedByPeer, handle, pane.container, pane.terminal])

  if (!isWatchedByPeer || remoteParticipants.size === 0 || cellMetrics.cellWidth <= 0) {
    return null
  }

  return (
    <div
      className="pointer-events-none absolute z-20 overflow-hidden"
      style={{
        left: cellMetrics.originLeft,
        top: cellMetrics.originTop,
        width: cellMetrics.cellWidth * cellMetrics.cols,
        height: cellMetrics.cellHeight * cellMetrics.rows
      }}
    >
      <RemoteTerminalPresenceOverlay
        participants={Array.from(remoteParticipants.values())}
        metrics={cellMetrics}
      />
    </div>
  )
}
