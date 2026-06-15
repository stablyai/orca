import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { buildDefaultTerminalOptions } from '../../lib/pane-manager/pane-terminal-options'
import { createIpcPtyTransport } from '../terminal-pane/pty-transport'

/**
 * Bind a fresh xterm Terminal to a PTY spawned with `command`/`connectionId`,
 * reusing the shared IPC PTY transport. The PTY is created on mount and killed
 * on unmount; callers remount (via a React key) to retarget a new container/tab.
 */
export function useEmbeddedPtyTerminal(params: {
  command: string
  connectionId: string | null
}): { containerRef: React.RefObject<HTMLDivElement | null> } {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const host = containerRef.current
    if (!host) return

    const term = new Terminal(buildDefaultTerminalOptions())
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(host)
    fitAddon.fit()

    // The effect re-runs whenever command/connectionId change, so reading them
    // directly is current — no ref needed to avoid a stale closure.
    const transport = createIpcPtyTransport({
      command: params.command,
      connectionId: params.connectionId
    })

    let disposed = false
    // Why: PtyTransport.connect() requires a `url` field in its type signature
    // (used by WebSocket transports) but the IPC implementation ignores it —
    // command and connectionId are passed via the closure above. Pass an empty
    // string to satisfy the type without affecting runtime behaviour.
    //
    // Why: connect() returns `void | Promise<...>` — wrap in Promise.resolve so
    // we can attach a rejection handler without a type error on bare `void`.
    void Promise.resolve(
      transport.connect({
        url: '',
        cols: term.cols,
        rows: term.rows,
        callbacks: {
          onData: (data: string) => term.write(data),
          onReplayData: (data: string) => term.write(data),
          onError: (message: string) => term.writeln(`\r\n\x1b[31m[orca] ${message}\x1b[0m`),
          onExit: () => {
            if (!disposed) term.writeln('\r\n\x1b[2m[process exited]\x1b[0m')
          }
        }
      })
    ).catch((error) => {
      if (!disposed) term.writeln(`\r\n\x1b[31m[orca] ${String(error)}\x1b[0m`)
    })

    const inputSub = term.onData((data) => transport.sendInput(data))

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        transport.resize(term.cols, term.rows)
      } catch {
        // Container can be transiently zero-sized during layout; ignore.
      }
    })
    observer.observe(host)

    return () => {
      disposed = true
      observer.disconnect()
      inputSub.dispose()
      transport.destroy?.()
      term.dispose()
    }
  }, [params.command, params.connectionId])

  return { containerRef }
}
