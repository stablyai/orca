import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { useAppStore } from '@/store'
import { buildPreviewTerminalOptions } from '../dashboard-popout/preview-terminal-options'
import { createPreviewBoxFit } from '../dashboard-popout/preview-terminal-box-fit'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { getRemoteRuntimeTerminalMultiplexer } from '@/runtime/remote-runtime-terminal-multiplexer'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { composeActiveTerminalTheme } from '../terminal-pane/terminal-appearance'

export function WorkspaceTerminalWatcher({ ptyId, viewId }: { ptyId: string; viewId: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [pendingRetry, setPendingRetry] = useState<{ run: () => Promise<void> } | null>(null)
  useEffect(() => {
    if (!pendingRetry) {
      return
    }
    const timer = setTimeout(() => void pendingRetry.run(), 500)
    return () => clearTimeout(timer)
  }, [pendingRetry])
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    setError(null)
    setPendingRetry(null)
    let disconnect = (): void => {}
    const settings = useAppStore.getState().settings
    const appearance = settings
      ? resolveEffectiveTerminalAppearance(
          settings,
          window.matchMedia('(prefers-color-scheme: dark)').matches
        )
      : null
    const terminal = new Terminal({
      ...buildPreviewTerminalOptions({
        settings: useAppStore.getState().settings,
        terminalInput: null,
        macOptionIsMeta: false,
        theme:
          appearance && settings
            ? composeActiveTerminalTheme(
                appearance.theme ?? getBuiltinTheme(appearance.themeName),
                settings
              )
            : null,
        themeMode: appearance?.mode ?? 'dark',
        cols: 80,
        rows: 24,
        scrollback: 1000
      }),
      disableStdin: true
    })
    terminal.open(container)
    const fit = createPreviewBoxFit({ container, getTerminal: () => (disposed ? null : terminal) })
    const observer = new ResizeObserver(fit.schedule)
    observer.observe(container)
    const write = (data: string, done?: () => void): void => {
      if (!disposed) {
        terminal.write(data, () => {
          fit.schedule()
          done?.()
        })
      }
    }
    const remote = parseRemoteRuntimePtyId(ptyId)
    const start = async (): Promise<void> => {
      if (remote?.environmentId) {
        const stream = await getRemoteRuntimeTerminalMultiplexer(
          remote.environmentId
        ).subscribeTerminal({
          terminal: remote.handle,
          client: { id: `workspace-view:${viewId}`, type: 'desktop' },
          callbacks: {
            onData: (data) => write(data),
            onSnapshot: (data, meta) => {
              if (disposed) {
                return
              }
              setError(null)
              terminal.reset()
              if (meta?.cols && meta.rows) {
                terminal.resize(meta.cols, meta.rows)
              }
              write(data + (meta?.pendingEscapeTailAnsi ?? ''))
            },
            onFitOverrideChanged: ({ cols, rows }) => {
              if (!disposed) {
                terminal.resize(cols, rows)
              }
            },
            onError: (message) => {
              if (!disposed) {
                setError(message)
              }
            }
          }
        })
        disconnect = () => stream.close()
        if (disposed) {
          disconnect()
        }
        return
      }
      const api = window.api.terminalPreview
      let buffering = true
      let pending: TerminalPreviewDataPayload[] = []
      let inFlight = false
      const retry = (): void => {
        if (disposed) {
          return
        }
        setPendingRetry({ run: connect })
      }
      const apply = (event: TerminalPreviewDataPayload): void => {
        if (disposed || event.ptyId !== ptyId || event.viewId !== viewId) {
          return
        }
        if (buffering) {
          pending.push(event)
          return
        }
        if (event.type === 'resync') {
          void connect()
          return
        }
        write(event.data, () => {
          void api.ack(ptyId, event.bytes, viewId)
        })
      }
      const capture = async (): Promise<void> => {
        buffering = true
        pending = []
        const result = await api.connect(ptyId, { viewId, scrollbackRows: 1000 })
        if (disposed) {
          void api.unsubscribe(ptyId, viewId)
          return
        }
        if (!result.snapshot) {
          throw new Error('Session unavailable')
        }
        setError(null)
        terminal.reset()
        terminal.resize(result.snapshot.cols, result.snapshot.rows)
        write(
          (result.snapshot.scrollbackAnsi ?? '') +
            result.snapshot.data +
            (result.snapshot.pendingEscapeTailAnsi ?? '')
        )
        for (const chunk of result.replay) {
          write(chunk.data)
        }
        buffering = false
        const events = pending
        pending = []
        for (const event of events) {
          apply(event)
        }
        if (result.resyncRequired) {
          retry()
        }
      }
      const connect = async (): Promise<void> => {
        if (disposed || inFlight) {
          retry()
          return
        }
        inFlight = true
        try {
          await capture()
        } catch (reason) {
          if (!disposed) {
            setError(String(reason))
            retry()
          }
        } finally {
          inFlight = false
        }
      }
      const unsubscribe = api.onData(apply)
      disconnect = () => {
        unsubscribe()
        void api.unsubscribe(ptyId, viewId)
      }
      await connect()
    }
    void start().catch((reason) => {
      if (!disposed) {
        setError(String(reason))
      }
    })
    return () => {
      disposed = true
      disconnect()
      observer.disconnect()
      terminal.dispose()
    }
  }, [ptyId, viewId])
  return (
    <div
      className="relative flex h-full w-full overflow-hidden"
      data-watching-terminal-view={viewId}
    >
      <div ref={containerRef} className="shrink-0" />
      {error && (
        <p
          role="status"
          className="absolute inset-0 p-4 text-sm text-muted-foreground bg-background"
        >
          {error}
        </p>
      )}
    </div>
  )
}
