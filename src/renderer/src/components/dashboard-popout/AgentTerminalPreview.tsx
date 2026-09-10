import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import {
  buildPreviewAppearanceOptions,
  buildPreviewTerminalOptions
} from './preview-terminal-options'
import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'
import { terminalPreviewUnavailableMessage } from './terminal-preview-unavailable-message'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { createPreviewGridClaim } from './preview-grid-claim'
import { dispatchAppMenuPasteEvent } from '@/lib/app-menu-paste'
import { createInteractiveAgentTerminalPreviewController } from './agent-terminal-preview-interaction'
import {
  connectAgentTerminalPreview,
  createAgentTerminalPreviewFitScheduler,
  createAgentTerminalPreviewResizeScheduler,
  createAgentTerminalPreviewWriter,
  createPassiveAgentTerminalLiveQueue,
  preparePassiveAgentTerminalOutput,
  retainAgentTerminalPreviewConnection,
  scheduleAgentTerminalPreviewFrameTask,
  subscribeAgentTerminalPreviewStream
} from './agent-terminal-preview-stream'
import { installPreviewTerminalRightClickPaste } from './preview-terminal-right-click-paste'
import { isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'

const PREVIEW_SCROLLBACK_ROWS = 24
// Why: main only ever serializes PREVIEW_SCROLLBACK_ROWS of history into this
// terminal, so the pane's user-configured scrollback would only cost memory.
const PREVIEW_SCROLLBACK_BUFFER_ROWS = 1000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function syncTerminalPreviewInput(terminal: Terminal, inputEnabled: boolean): void {
  Object.assign(terminal.options ?? {}, { disableStdin: !inputEnabled })
  const textarea = terminal.textarea
  textarea?.setAttribute('tabindex', inputEnabled ? '0' : '-1')
  if (textarea && !inputEnabled && document.activeElement === textarea) {
    textarea.blur()
  }
}

export type AgentTerminalPreviewMode = 'interactive' | 'canvas' | 'passive'

/** Renders the exact PTY through a DOM xterm, with optional interactive ownership. */
export function AgentTerminalPreview({
  ptyId,
  terminalInput = null,
  autoFocus = true,
  className,
  mode = 'interactive',
  inputEnabled: inputEnabledProp,
  liveRefreshIntervalMs = 0
}: {
  ptyId: string
  /** Host-input facts relayed with the card; null routes bytes by client OS. */
  terminalInput?: DashboardCardTerminalInput | null
  autoFocus?: boolean
  className?: string
  mode?: AgentTerminalPreviewMode
  inputEnabled?: boolean
  liveRefreshIntervalMs?: number
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const scheduleFitRef = useRef<(() => void) | null>(null)
  const settings = useAppStore((state) => state.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const macOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  // Why: keys and appearance must read live values without remounting the
  // terminal (a remount reconnects the pty and repaints from a new snapshot).
  const settingsRef = useRef(settings)
  const macOptionAsAltRef = useRef(macOptionAsAlt)
  const terminalInputRef = useRef(terminalInput)
  const acceptsInput = mode !== 'passive'
  const inputEnabled = acceptsInput && (inputEnabledProp ?? true)
  const ownsPtyGrid = mode !== 'passive'
  const usesBufferedRendering = mode !== 'interactive'
  const { terminalTheme, terminalMode } = useMemo(() => {
    if (!settings) {
      return { terminalTheme: null, terminalMode: 'dark' as const }
    }
    const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    const theme = composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    )
    return { terminalTheme: theme, terminalMode: appearance.mode }
  }, [settings, systemPrefersDark])
  const inputEnabledRef = useRef(inputEnabled)
  const autoFocusRef = useRef(autoFocus)
  const liveRefreshIntervalMsRef = useRef(liveRefreshIntervalMs)
  const terminalThemeRef = useRef(terminalTheme)
  const terminalModeRef = useRef(terminalMode)
  // A null snapshot means no serializer knows this pty (it died or was never
  // spawned this session) — say so instead of painting a silent blank terminal.
  const [ptyGone, setPtyGone] = useState(false)

  // Why: refs are seeded at first render and refreshed on commit — assigning
  // during render trips react-compiler. Layout, not passive: xterm's keydown is
  // a native listener, so React would not flush a passive effect before the
  // next keystroke and a just-relayed profile could miss it.
  useLayoutEffect(() => {
    settingsRef.current = settings
    macOptionAsAltRef.current = macOptionAsAlt
    terminalInputRef.current = terminalInput
    inputEnabledRef.current = inputEnabled
    autoFocusRef.current = autoFocus
    liveRefreshIntervalMsRef.current = liveRefreshIntervalMs
    terminalThemeRef.current = terminalTheme
    terminalModeRef.current = terminalMode
  }, [
    settings,
    macOptionAsAlt,
    terminalInput,
    inputEnabled,
    autoFocus,
    liveRefreshIntervalMs,
    terminalTheme,
    terminalMode
  ])

  useEffect(() => {
    setPtyGone(false)
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    let terminal: Terminal | null = null
    let offData: (() => void) | null = null
    let refreshInFlight = false
    let refreshAgain = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let cancelPendingTerminalMount: (() => void) | null = null
    const fitScheduler = createAgentTerminalPreviewFitScheduler({
      container,
      getTerminal: () => terminal
    })
    const scheduleFit = fitScheduler.schedule
    scheduleFitRef.current = scheduleFit
    const releaseConnection = retainAgentTerminalPreviewConnection(ptyId)

    let gridClaim = ownsPtyGrid
      ? createPreviewGridClaim({
          ptyId,
          container,
          getTerminal: () => terminal
        })
      : null
    const resizeScheduler = createAgentTerminalPreviewResizeScheduler({
      passive: !ownsPtyGrid,
      settleMs: 120,
      scheduleFit,
      scheduleGrid: () => gridClaim?.schedule()
    })
    const boxResizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resizeScheduler.schedule)
    if (container.parentElement) {
      boxResizeObserver?.observe(container.parentElement)
    }
    boxResizeObserver?.observe(container)
    const previewWriter = createAgentTerminalPreviewWriter({
      getTerminal: () => terminal,
      isDisposed: () => disposed,
      onParsedWrite: mode === 'interactive' ? scheduleFit : () => undefined
    })
    const passiveLiveQueue = createPassiveAgentTerminalLiveQueue({
      ptyId,
      get intervalMs() {
        return liveRefreshIntervalMsRef.current
      },
      isDisposed: () => disposed,
      write: previewWriter.writeLive
    })
    const writeLive = (
      payload: Extract<TerminalPreviewDataPayload, { type: 'data' }>
    ): Promise<void> => {
      if (!usesBufferedRendering || liveRefreshIntervalMsRef.current <= 0) {
        return previewWriter.writeLive(payload)
      }
      return passiveLiveQueue.write(payload)
    }

    const interaction = acceptsInput
      ? createInteractiveAgentTerminalPreviewController({
          ptyId,
          container,
          getTerminal: () => terminal,
          getTerminalInput: () => terminalInputRef.current,
          getSettings: () => settingsRef.current,
          getMacOptionAsAlt: () => macOptionAsAltRef.current,
          getKittyKeyboardFlags: () => previewWriter.kittyKeyboardModes.flags,
          getInputEnabled: () => inputEnabledRef.current,
          isDisposed: () => disposed,
          isReplaying: previewWriter.isReplaying
        })
      : null
    const disposeRightClickPaste = installPreviewTerminalRightClickPaste({
      container,
      getTerminal: () => terminal,
      isRightClickToPasteEnabled: () =>
        acceptsInput &&
        inputEnabledRef.current &&
        (settingsRef.current?.terminalRightClickToPaste ?? isWindowsUserAgent()),
      pasteClipboardText: () => void dispatchAppMenuPasteEvent()
    })

    let resourcesReleased = false
    const releaseResources = (): void => {
      if (resourcesReleased) {
        return
      }
      resourcesReleased = true
      if (retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      resizeScheduler.dispose()
      cancelPendingTerminalMount?.()
      cancelPendingTerminalMount = null
      fitScheduler.dispose()
      if (scheduleFitRef.current === scheduleFit) {
        scheduleFitRef.current = null
      }
      gridClaim?.dispose()
      gridClaim = null
      boxResizeObserver?.disconnect()
      offData?.()
      offData = null
      interaction?.dispose()
      disposeRightClickPaste()
      passiveLiveQueue.release()
      previewWriter.releasePending()
      releaseConnection()
      terminal?.dispose()
      terminal = null
      terminalRef.current = null
    }

    const replayConnection = (
      connection: Awaited<ReturnType<typeof window.api.terminalPreview.connect>>,
      replaceExisting: boolean,
      requestRefresh: () => void
    ): void => {
      const snap = connection.snapshot!
      const sourceGrid = {
        cols: clamp(snap.cols ?? 80, 2, 500),
        rows: clamp(snap.rows ?? 24, 2, 200)
      }
      if (!terminal) {
        terminal = new Terminal({
          ...buildPreviewTerminalOptions({
            settings: settingsRef.current,
            terminalInput: terminalInputRef.current,
            macOptionIsMeta: macOptionAsAltRef.current === 'true',
            theme: terminalThemeRef.current,
            themeMode: terminalModeRef.current,
            cols: sourceGrid.cols,
            rows: sourceGrid.rows,
            scrollback: PREVIEW_SCROLLBACK_BUFFER_ROWS
          }),
          disableStdin: !inputEnabledRef.current
        })
        try {
          terminal.open(container)
        } catch {
          terminal.dispose()
          terminal = null
          return
        }
        terminalRef.current = terminal
        if (!acceptsInput) {
          preparePassiveAgentTerminalOutput(terminal, settingsRef.current)
        } else {
          interaction?.install()
        }
        syncTerminalPreviewInput(terminal, inputEnabledRef.current)
      } else if (replaceExisting) {
        // Why: keep the old frame visible during capture, then atomically replace it once the authoritative snapshot arrives.
        terminal.resize(sourceGrid.cols, sourceGrid.rows)
        terminal.reset()
      }
      previewWriter.replay(connection)
      if (connection.resyncRequired) {
        refreshAgain = false
        // Why: sustained output can overflow every capture; delay retries so recovery cannot spin two serializations per event-loop turn.
        previewWriter.writeBarrier(() => {
          if (disposed || retryTimer) {
            return
          }
          retryTimer = setTimeout(() => {
            retryTimer = null
            requestRefresh()
          }, 150)
        })
      } else if (refreshAgain) {
        refreshAgain = false
        // Queue behind every replay write so replacement never clears a half-parsed frame.
        previewWriter.writeBarrier(requestRefresh)
      }
      if (!ownsPtyGrid) {
        previewWriter.writeBarrier(scheduleFit)
      } else {
        scheduleFit()
        gridClaim?.schedule()
      }
      if (ownsPtyGrid && inputEnabledRef.current && autoFocusRef.current) {
        terminal.focus()
      }
    }

    const setup = async (replaceExisting = false): Promise<void> => {
      if (refreshInFlight) {
        refreshAgain = true
        return
      }
      refreshInFlight = true
      const connection = await connectAgentTerminalPreview(ptyId, {
        scrollbackRows: PREVIEW_SCROLLBACK_ROWS
      })
      if (disposed) {
        return
      }
      const snap = connection.snapshot
      if (!snap) {
        refreshInFlight = false
        setPtyGone(true)
        disposed = true
        releaseResources()
        return
      }
      refreshInFlight = false
      if (!connection.resyncRequired && retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      const replay = (): void => {
        cancelPendingTerminalMount = null
        if (!disposed) {
          replayConnection(connection, replaceExisting, () => void setup(true))
        }
      }
      if (usesBufferedRendering && liveRefreshIntervalMsRef.current > 0 && !terminal) {
        cancelPendingTerminalMount?.()
        cancelPendingTerminalMount = scheduleAgentTerminalPreviewFrameTask(replay)
      } else {
        replay()
      }
    }

    offData = subscribeAgentTerminalPreviewStream(ptyId, (payload) => {
      if (payload.type === 'resync') {
        passiveLiveQueue.release()
        void setup(true)
        return
      }
      return writeLive(payload)
    })

    void setup()

    return () => {
      disposed = true
      releaseResources()
    }
  }, [acceptsInput, mode, ownsPtyGrid, ptyId, usesBufferedRendering])

  useLayoutEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    syncTerminalPreviewInput(terminal, inputEnabled)
    if (inputEnabled && autoFocus) {
      terminal.focus()
    }
  }, [autoFocus, inputEnabled])

  // Why: appearance settings must land on the open terminal, and the OS input
  // source can flip Option-as-Alt with no settings change at all. A remount
  // would reconnect the pty and repaint the agent's screen from a new snapshot.
  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) {
      return
    }
    Object.assign(
      terminal.options,
      buildPreviewAppearanceOptions(settings, macOptionAsAlt === 'true')
    )
    syncPreviewTerminalLigatures(terminal, settings)
    scheduleFitRef.current?.()
  }, [settings, macOptionAsAlt])

  return (
    // Why: a size FIXED by the viewport (not shrink-to-fit) + overflow-hidden
    // keeps the dialog stable no matter how wide/tall the pane's serialized
    // buffer is. The terminal keeps the pane's true dimensions and is scaled/
    // clipped to fit; createPreviewBoxFit anchors the end that shows the cursor.
    <div
      data-terminal-preview-mode={mode}
      data-terminal-preview-input={inputEnabled ? 'enabled' : 'disabled'}
      data-terminal-preview-pty-id={ptyId}
      className={cn(
        'relative h-[calc(100vh-140px)] w-full overflow-hidden bg-background p-1.5',
        className
      )}
      style={terminalTheme?.background ? { backgroundColor: terminalTheme.background } : undefined}
    >
      {ptyGone ? (
        <div className="absolute inset-0 flex items-center justify-center px-2.5 py-8 text-center text-[11px] text-muted-foreground">
          {terminalPreviewUnavailableMessage({ ptyId })}
        </div>
      ) : null}
      <div
        aria-hidden={ptyGone || undefined}
        className={cn('flex h-full w-full items-end overflow-hidden', ptyGone && 'invisible')}
      >
        <div
          ref={containerRef}
          className={cn('origin-bottom-left', !inputEnabled && 'pointer-events-none select-none')}
        />
      </div>
    </div>
  )
}
