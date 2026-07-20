import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PinnedTerminalPanel } from '../../../../shared/types'
import type { PanelCanvasLeaf } from '@/lib/panel-canvas'
import { translate } from '@/i18n/i18n'

/** Popout-window terminal tile: a bare xterm over the slim popoutPty channel
 *  (direct node-pty in main, owned by this window). Live TUIs only — no
 *  scrollback restore, tabs, or pane-manager machinery. */
export function PopoutTerminalTile({
  leaf,
  panel
}: {
  leaf: PanelCanvasLeaf
  panel: PinnedTerminalPanel
}): React.JSX.Element {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [exited, setExited] = React.useState(false)

  React.useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    setError(null)
    setExited(false)
    const terminal = new Terminal({
      fontSize: 12,
      fontFamily: 'monospace',
      cursorBlink: false,
      scrollback: 1000,
      theme: { background: '#0a0a0a' }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    fit.fit()

    let ptyId: string | null = null
    let disposed = false
    const cleanups: (() => void)[] = []

    void window.api.panelCanvasPopout.pty
      .spawn({
        host: panel.host ?? null,
        command: panel.command,
        cols: terminal.cols,
        rows: terminal.rows
      })
      .then((result) => {
        if (disposed) {
          if (result.ok) {
            void window.api.panelCanvasPopout.pty.kill({ id: result.id })
          }
          return
        }
        if (!result.ok) {
          setError(result.error)
          return
        }
        ptyId = result.id
        cleanups.push(
          window.api.panelCanvasPopout.pty.onData((payload) => {
            if (payload.id === ptyId) {
              terminal.write(payload.data)
            }
          }),
          window.api.panelCanvasPopout.pty.onExit((payload) => {
            if (payload.id === ptyId) {
              setExited(true)
            }
          })
        )
        const inputDisposable = terminal.onData((data) => {
          if (ptyId !== null) {
            void window.api.panelCanvasPopout.pty.input({ id: ptyId, data })
          }
        })
        cleanups.push(() => inputDisposable.dispose())
      })

    const resizeObserver = new ResizeObserver(() => {
      // Why: fit throws on a zero-size container (parked tile mid-layout).
      try {
        fit.fit()
      } catch {
        return
      }
      if (ptyId !== null) {
        void window.api.panelCanvasPopout.pty.resize({
          id: ptyId,
          cols: terminal.cols,
          rows: terminal.rows
        })
      }
    })
    resizeObserver.observe(container)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      for (const cleanup of cleanups) {
        cleanup()
      }
      if (ptyId !== null) {
        void window.api.panelCanvasPopout.pty.kill({ id: ptyId })
      }
      terminal.dispose()
    }
    // Why: leaf.id keys the tile instance — a re-created leaf (reattach round
    // trip) must spawn a fresh PTY; panel command/host edits likewise.
  }, [leaf.id, panel.host, panel.command])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#0a0a0a]">
      <div ref={containerRef} className="min-h-0 flex-1" />
      {error !== null || exited ? (
        <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted-foreground">
          {error !== null
            ? error === 'host-unresolved'
              ? translate(
                  'auto.components.panel-canvas.PopoutTerminalTile.hostUnresolved',
                  'SSH host not found — check the panel host in Settings.'
                )
              : error
            : translate('auto.components.panel-canvas.PopoutTerminalTile.exited', 'Command exited')}
        </div>
      ) : null}
    </div>
  )
}
