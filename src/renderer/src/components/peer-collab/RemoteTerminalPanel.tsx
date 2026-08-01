import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'
import { useRemoteTerminalTheme } from './use-remote-terminal-theme'
import { translate } from '@/i18n/i18n'
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
import { PEER_TERMINAL_GRANT_REVOKED_REASON } from '../../../../shared/peer-terminal-stream-event'
import { RemoteTerminalPresenceOverlay } from './RemoteTerminalPresenceOverlay'
import { usePeerTerminalSubscribers } from './use-peer-terminal-subscribers'

const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24
// Why: gates continuous cursor/scroll sends to ~60Hz without ever queuing
// them — queuing is what makes remote cursors look choppy.
const PRESENCE_SEND_THROTTLE_MS = 16

/**
 * Renders one host terminal streamed over an active peer connection. Owns its
 * own xterm instance (fed by terminal.subscribe's SnapshotStart/Chunk/End and
 * Output frames via the main process's PeerClientService) and forwards local
 * keystrokes and resizes back to the host over the same stream.
 */
export function RemoteTerminalPanel({
  hostId,
  terminalHandle,
  hidden = false
}: {
  hostId: string
  terminalHandle: string
  /** Backgrounded by the keep-alive panel stack — stays mounted but tells the host to stop counting this subscriber as an active viewer. */
  hidden?: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const requestIdRef = useRef<string | null>(null)
  const refitRef = useRef<() => void>(() => {})
  const settings = useAppStore((state) => state.settings)
  // Why: presence sends read the name through a ref so a rename never forces
  // the terminal-subscription effect to tear down and resubscribe.
  const ownDisplayNameRef = useRef('Peer')
  ownDisplayNameRef.current = settings?.peerCollabDisplayName?.trim() || 'Peer'
  // Why: read inside the async subscribe IIFE, which resolves after this render.
  const hiddenRef = useRef(hidden)
  hiddenRef.current = hidden
  const [ended, setEnded] = useState(false)
  const [errorReason, setErrorReason] = useState<string | null>(null)
  const [remoteCwd, setRemoteCwd] = useState<string | null>(null)
  const otherSubscribers = usePeerTerminalSubscribers(hostId, terminalHandle, hidden)
  const [remoteParticipants, setRemoteParticipants] = useState<Map<string, PeerPresenceState>>(
    () => new Map()
  )
  const [cellMetrics, setCellMetrics] = useState({
    cellWidth: 0,
    cellHeight: 0,
    cols: FALLBACK_COLS,
    rows: FALLBACK_ROWS,
    originLeft: 0,
    originTop: 0
  })
  const { terminalTheme, terminalMode } = useRemoteTerminalTheme(settings)

  useEffect(() => {
    setEnded(false)
    setErrorReason(null)
    setRemoteCwd(null)
    setRemoteParticipants(new Map())
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    let requestId: string | null = null
    let lastSentCols = 0
    let lastSentRows = 0
    let presenceRequestId: string | null = null
    let ownClientId: string | null = null
    let lastPresenceSendAt = 0
    let ownCursor: PeerPresenceCursor = null
    let ownSelection: PeerPresenceSelection = null
    let ownScroll: PeerPresenceScroll = { atBottom: true, scrollTop: 0 }
    // Why: mousemove needs the current cell geometry synchronously; React state
    // set via updateCellMetrics only reaches this closure on the next render.
    let localCellMetrics: TerminalCellGeometry = {
      cellWidth: 0,
      cellHeight: 0,
      originLeft: 0,
      originTop: 0
    }

    const terminal = new Terminal({
      ...buildDefaultTerminalOptions(),
      cols: FALLBACK_COLS,
      rows: FALLBACK_ROWS,
      theme: terminalTheme ?? undefined,
      minimumContrastRatio: resolveTerminalMinimumContrastRatio(
        terminalTheme?.background,
        terminalMode
      ),
      scrollback: 1000
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(container)

    const sendResizeIfChanged = (): void => {
      if (!requestId || (terminal.cols === lastSentCols && terminal.rows === lastSentRows)) {
        return
      }
      lastSentCols = terminal.cols
      lastSentRows = terminal.rows
      void window.api.peerClient.resizeTerminalStream({
        requestId,
        cols: terminal.cols,
        rows: terminal.rows
      })
    }

    const proposeFit = (): { cols: number; rows: number } => {
      const proposed = fitAddon.proposeDimensions()
      if (proposed && proposed.cols > 0 && proposed.rows > 0) {
        terminal.resize(proposed.cols, proposed.rows)
      }
      return { cols: terminal.cols, rows: terminal.rows }
    }

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
      if (!presenceRequestId || !ownClientId) {
        return
      }
      const now = performance.now()
      if (!immediate && now - lastPresenceSendAt < PRESENCE_SEND_THROTTLE_MS) {
        return
      }
      lastPresenceSendAt = now
      void window.api.peerClient.sendPresenceState({
        hostId,
        terminal: terminalHandle,
        state: {
          participant: {
            clientId: ownClientId,
            name: ownDisplayNameRef.current,
            color: assignPeerPresenceColor(ownClientId)
          },
          cursor: ownCursor,
          selection: ownSelection,
          scroll: ownScroll
        }
      })
    }

    const offEvent = window.api.peerClient.onTerminalStreamEvent(({ requestId: id, event }) => {
      if (id !== requestId || disposed) {
        return
      }
      switch (event.type) {
        case 'subscribed':
          return // ack only — the snapshot that follows carries the renderable state
        case 'snapshot':
          terminal.resize(event.cols, event.rows)
          terminal.reset()
          terminal.write(event.data)
          lastSentCols = event.cols
          lastSentRows = event.rows
          updateCellMetrics()
          return
        case 'output':
          terminal.write(event.data)
          return
        case 'resized':
          terminal.resize(event.cols, event.rows)
          lastSentCols = event.cols
          lastSentRows = event.rows
          updateCellMetrics()
          return
        case 'metadata':
          setRemoteCwd(event.cwd)
          return
        case 'error':
          setErrorReason(event.message)
          return
        case 'end':
          setEnded(true)
      }
    })

    // Why: a slow/disconnecting listener elsewhere must never delay this
    // frame's own input path, so presence is wired entirely off `terminal.onData`.
    const offPresenceEvent = window.api.peerClient.onPresenceEvent(({ requestId: id, event }) => {
      if (id !== presenceRequestId || disposed) {
        return
      }
      if (event.type === 'state') {
        setRemoteParticipants((prev) => {
          const next = new Map(prev)
          next.set(event.state.participant.clientId, event.state)
          return next
        })
        return
      }
      if (event.type === 'left') {
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

    terminal.onData((data) => {
      if (requestId) {
        void window.api.peerClient.sendTerminalInput({ requestId, data })
      }
    })

    terminal.onScroll(() => {
      const buffer = terminal.buffer.active
      ownScroll = { atBottom: buffer.viewportY >= buffer.baseY, scrollTop: buffer.viewportY }
      sendOwnPresence(false)
    })

    terminal.onSelectionChange(() => {
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

    const refit = (): void => {
      proposeFit()
      sendResizeIfChanged()
      updateCellMetrics()
    }
    const resizeObserver = new ResizeObserver(refit)
    resizeObserver.observe(container)
    refitRef.current = refit

    void (async () => {
      const { cols, rows } = proposeFit()
      updateCellMetrics()
      ownClientId = (await window.api.peerClient.getClientId({ hostId })).clientId
      const [terminalResult, presenceResult] = await Promise.all([
        window.api.peerClient.subscribeTerminal({ hostId, terminal: terminalHandle, cols, rows }),
        window.api.peerClient.subscribePresence({ hostId, terminal: terminalHandle })
      ])
      if (presenceResult.ok) {
        presenceRequestId = presenceResult.requestId
      }
      if (disposed) {
        // Component unmounted while the IPC round-trip was pending: the host already
        // created the subscription, so tear it down instead of leaking it.
        if (terminalResult.ok) {
          void window.api.peerClient.unsubscribeTerminal({ requestId: terminalResult.requestId })
        }
        if (presenceResult.ok) {
          void window.api.peerClient.unsubscribePresence({ requestId: presenceResult.requestId })
        }
        return
      }
      if (!terminalResult.ok) {
        setErrorReason(terminalResult.reason)
        return
      }
      requestId = terminalResult.requestId
      requestIdRef.current = requestId
      // Sync now: the sibling hidden-negotiation effect may have already run and
      // found requestIdRef null, so it never told the host this subscriber is hidden.
      void window.api.peerClient.setTerminalStreamHidden({ requestId, hidden: hiddenRef.current })
      terminal.focus()
    })()

    return () => {
      disposed = true
      resizeObserver.disconnect()
      offEvent()
      offPresenceEvent()
      container.removeEventListener('mousemove', handleMouseMove)
      container.removeEventListener('mouseleave', handleMouseLeave)
      requestIdRef.current = null
      if (presenceRequestId) {
        void window.api.peerClient.unsubscribePresence({ requestId: presenceRequestId })
      }
      if (requestId) {
        void window.api.peerClient.unsubscribeTerminal({ requestId })
      }
      terminal.dispose()
    }
  }, [hostId, terminalHandle, terminalTheme, terminalMode])

  // Why: keep-alive panels stay mounted while backgrounded — tell the host so it
  // stops billing this subscriber as an active viewer, and refit once shown again
  // since xterm can't measure a hidden (visibility:hidden) container.
  const wasHiddenRef = useRef(hidden)
  useEffect(() => {
    const requestId = requestIdRef.current
    if (requestId) {
      void window.api.peerClient.setTerminalStreamHidden({ requestId, hidden })
    }
    if (wasHiddenRef.current && !hidden) {
      refitRef.current()
    }
    wasHiddenRef.current = hidden
  }, [hidden])

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-background p-1.5"
      style={terminalTheme?.background ? { backgroundColor: terminalTheme.background } : undefined}
    >
      {!ended && !errorReason && (remoteCwd || otherSubscribers.length > 0) ? (
        <div className="pointer-events-none absolute top-1.5 right-2.5 z-10 flex max-w-[60%] flex-col items-end gap-0.5">
          {remoteCwd ? (
            <div className="truncate rounded-xs bg-background/80 px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {remoteCwd}
            </div>
          ) : null}
          {otherSubscribers.length > 0 ? (
            <div className="truncate rounded-xs bg-background/80 px-1.5 py-0.5 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.peer-collab.RemoteTerminalPanel.otherSubscribers',
                'Also watching: {{names}}',
                { names: otherSubscribers.join(', ') }
              )}
            </div>
          ) : null}
        </div>
      ) : null}
      {ended || errorReason ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 px-2.5 py-8 text-center text-[11px] text-muted-foreground">
          {errorReason === PEER_TERMINAL_GRANT_REVOKED_REASON
            ? translate(
                'auto.components.peer-collab.RemoteTerminalPanel.grantRevoked',
                'The host stopped sharing this terminal.'
              )
            : errorReason
              ? translate(
                  'auto.components.peer-collab.RemoteTerminalPanel.error',
                  'Could not open this terminal: {{reason}}',
                  { reason: errorReason }
                )
              : translate(
                  'auto.components.peer-collab.RemoteTerminalPanel.ended',
                  'This terminal stream has ended.'
                )}
        </div>
      ) : null}
      {/* Why: an unpadded positioned wrapper around containerRef so the overlay
          below shares containerRef's own coordinate space — cellMetrics.origin*
          is measured relative to containerRef, and the outer root's p-1.5
          padding would otherwise offset an overlay positioned against it. */}
      <div className="relative h-full w-full">
        <div ref={containerRef} className="h-full w-full" />
        {!ended && !errorReason && cellMetrics.cellWidth > 0 ? (
          <div
            className="pointer-events-none absolute overflow-hidden"
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
        ) : null}
      </div>
    </div>
  )
}
