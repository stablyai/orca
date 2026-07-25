import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { History } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { subscribeToTerminalUserInput } from '@/components/terminal-pane/terminal-user-input-signal'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { replayPreviewConnectionSnapshot } from './preview-terminal-snapshot-replay'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import {
  buildPreviewAppearanceOptions,
  buildPreviewTerminalOptions
} from './preview-terminal-options'
import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'
import { installPreviewTerminalCompatibility } from './preview-terminal-compatibility'
import { createPreviewClipboardPaster } from './preview-terminal-paste'
import { installPreviewImeBridge, type PreviewImeBridge } from './preview-terminal-ime-bridge'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { translate } from '@/i18n/i18n'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { installPreviewTerminalKeyHandler } from './preview-terminal-key-handler'
import { createPreviewGridClaim } from './preview-grid-claim'
import { installPreviewTerminalAppMenuClipboard } from './preview-terminal-app-menu-clipboard'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'

const PREVIEW_SCROLLBACK_ROWS = 24
// Why: main only ever serializes PREVIEW_SCROLLBACK_ROWS of history into this
// terminal, so the pane's user-configured scrollback would only cost memory.
const PREVIEW_SCROLLBACK_BUFFER_ROWS = 1000
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24
const RESYNC_RETRY_DELAY_MS = 150

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Live interactive view of an agent's terminal, streaming from the main
 * process's per-PTY headless emulator. On open it claims the PTY grid for the
 * dialog's own box (see createPreviewGridClaim), so the terminal renders
 * properly sized rather than scaled. The terminal itself is always created at
 * the PTY's REAL cols/rows — serialized ANSI replayed into different
 * dimensions rewraps into garbage — and when someone else owns the grid (a
 * phone, a host reclaim) the oversized frame is scaled down to fit and
 * anchored so the cursor stays visible. Keystrokes pass through to the PTY;
 * DOM renderer so it never grabs a WebGL context.
 *
 * When no PTY is left to serialize, main falls back to the daemon's on-disk
 * history and the frame arrives with live === false. That case renders the same
 * way but claims no grid and accepts no input — after a reboot it is the only
 * thing the board can show until the worktree is reopened.
 */
export function AgentTerminalPreview({
  ptyId,
  terminalInput = null,
  className
}: {
  ptyId: string
  /** Host-input facts relayed with the card; null routes bytes by client OS. */
  terminalInput?: DashboardCardTerminalInput | null
  className?: string
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const settings = useAppStore((state) => state.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const macOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  // Why: keys and appearance must read live values without remounting the
  // terminal (a remount reconnects the pty and repaints from a new snapshot).
  const settingsRef = useRef(settings)
  const macOptionAsAltRef = useRef(macOptionAsAlt)
  const terminalInputRef = useRef(terminalInput)
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
  // A null snapshot means no serializer knows this pty AND no history survives
  // it — say so instead of painting a silent blank terminal.
  const [ptyGone, setPtyGone] = useState(false)
  // A frame replayed from history: the session is over, so it renders but takes
  // no input and receives no live bytes.
  const [historical, setHistorical] = useState(false)

  // Why: refs are seeded at first render and refreshed on commit — assigning
  // during render trips react-compiler. Layout, not passive: xterm's keydown is
  // a native listener, so React would not flush a passive effect before the
  // next keystroke and a just-relayed profile could miss it.
  useLayoutEffect(() => {
    settingsRef.current = settings
    macOptionAsAltRef.current = macOptionAsAlt
    terminalInputRef.current = terminalInput
  }, [settings, macOptionAsAlt, terminalInput])

  useEffect(() => {
    setPtyGone(false)
    setHistorical(false)
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    let terminal: Terminal | null = null
    let terminalReadOnly = false
    let offData: (() => void) | null = null
    let userInputDisposable: { dispose: () => void } | null = null
    let imeBridge: PreviewImeBridge | null = null
    let disposeKeyHandler: (() => void) | null = null
    let disposeTerminalCompatibility: (() => void) | null = null
    // Why: mirrors the pane's tracker — the policy needs the flags the TUI
    // negotiated, and this preview parses the same output stream the pane does.
    const kittyKeyboardModes = new TerminalKittyKeyboardModeTracker()
    let refreshInFlight = false
    let refreshAgain = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const pendingLivePayloads: Extract<TerminalPreviewDataPayload, { type: 'data' }>[] = []

    const fitToBox = (): void => {
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      const box = container.parentElement
      if (!screen || !box || !terminal) {
        return
      }
      const scale = Math.min(1, box.clientWidth / Math.max(1, screen.offsetWidth))
      container.style.transform = scale < 1 ? `scale(${scale})` : ''
      // Anchor whichever end keeps the CURSOR row in view when the terminal is
      // taller than the box: a fresh shell prompts at the TOP of its screen
      // (blind bottom-anchoring clipped it away), while a busy TUI keeps its
      // action at the bottom.
      const cellHeight = screen.offsetHeight / Math.max(1, terminal.rows)
      const cursorBottom = (terminal.buffer.active.cursorY + 1) * cellHeight * scale
      const anchorTop = cursorBottom <= box.clientHeight
      box.style.alignItems = anchorTop ? 'flex-start' : 'flex-end'
      container.style.transformOrigin = anchorTop ? 'top left' : 'bottom left'
    }
    // Re-fit after every parsed write (cursor may move ends); rAF coalesces.
    let fitScheduled = false
    const scheduleFit = (): void => {
      if (fitScheduled) {
        return
      }
      fitScheduled = true
      requestAnimationFrame(() => {
        fitScheduled = false
        fitToBox()
      })
    }

    const gridClaim = createPreviewGridClaim({
      ptyId,
      container,
      getTerminal: () => terminal
    })
    // Box growth/shrink (window resize) changes the reachable grid.
    const boxResizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            scheduleFit()
            if (terminalReadOnly) {
              // Why here too, not just in replayConnection: mounting the
              // history banner resizes the box, so the observer would claim the
              // grid on its own — resizing a session that may still be running.
              return
            }
            gridClaim.schedule()
          })
    if (container.parentElement) {
      boxResizeObserver?.observe(container.parentElement)
    }
    boxResizeObserver?.observe(container)

    let replayDepth = 0
    const writeReplayed = (chunk: string, onDone?: () => void, live = false): void => {
      // Why: a redelivered snapshot repeats the TUI's one-time kitty push, so
      // replayed bytes must apply as idempotent sets (see the tracker's docs).
      if (live) {
        kittyKeyboardModes.scan(chunk)
      } else {
        kittyKeyboardModes.scanReplay(chunk)
      }
      replayDepth++
      terminal?.write(chunk, () => {
        replayDepth--
        scheduleFit()
        onDone?.()
      })
    }

    const writeLive = (payload: Extract<TerminalPreviewDataPayload, { type: 'data' }>): void => {
      if (!terminal) {
        pendingLivePayloads.push(payload)
        return
      }
      writeReplayed(
        payload.data,
        () => {
          if (!disposed) {
            void window.api.terminalPreview.ack(ptyId, payload.bytes)
          }
        },
        true
      )
    }

    const pasteClipboardText = createPreviewClipboardPaster({
      ptyId,
      container,
      getTerminal: () => terminal,
      getTerminalInput: () => terminalInputRef.current,
      isDisposed: () => disposed,
      isReadOnly: () => terminalReadOnly
    })

    const disposeImeNativeTextBridge = (): void => {
      imeBridge?.dispose()
      imeBridge = null
    }

    const installImeNativeTextBridge = (): void => {
      if (terminal) {
        // Why a live getter: kitty state can change between keydown and commit,
        // and the tracker outlives every reconnect inside this effect.
        imeBridge = installPreviewImeBridge(terminal, {
          getKittyKeyboardFlags: () => kittyKeyboardModes.flags
        })
      }
    }

    const installKeyHandler = (): void => {
      if (!terminal) {
        return
      }
      disposeKeyHandler = installPreviewTerminalKeyHandler({
        terminal,
        claimImeKeyEvent: (event) => imeBridge?.claimKeyEvent(event) ?? false,
        pasteClipboardText: (activeElement, source) =>
          void pasteClipboardText(activeElement, source),
        // Why: route through terminal.input so the chord's bytes carry core's user-input signal, like typed keys.
        sendInput: (data) => terminal?.input(data),
        getShortcutContext: () => ({
          clientPlatform: getShortcutPlatform(),
          macOptionAsAlt: macOptionAsAltRef.current,
          keybindings: useAppStore.getState().keybindings,
          terminalInput: terminalInputRef.current,
          kittyKeyboardActive: () => kittyKeyboardModes.flags > 0,
          terminalShortcutPolicy: settingsRef.current?.terminalShortcutPolicy
        })
      })
    }

    const installTerminalCompatibility = (): void => {
      if (!terminal) {
        return
      }
      disposeTerminalCompatibility = installPreviewTerminalCompatibility(terminal, {
        getSettings: () => settingsRef.current
      })
    }

    const installInputRouting = (): void => {
      if (!terminal) {
        return
      }
      let pendingUserInputSignals = 0
      userInputDisposable = subscribeToTerminalUserInput(terminal, () => {
        pendingUserInputSignals = Math.min(32, pendingUserInputSignals + 1)
      })
      terminal.onData((data) => {
        const signaledUserInput = pendingUserInputSignals > 0
        if (signaledUserInput) {
          pendingUserInputSignals--
        }
        // Why: core's signal distinguishes real input from parser replies, so typing survives live replay without forwarding synthetic CPR/DA bytes.
        if (userInputDisposable ? !signaledUserInput : replayDepth > 0) {
          return
        }
        void window.api.terminalPreview.input(ptyId, data)
      })
    }

    const replayConnection = (
      connection: Awaited<ReturnType<typeof window.api.terminalPreview.connect>>,
      replaceExisting: boolean,
      requestRefresh: () => void
    ): void => {
      const snap = connection.snapshot!
      const readOnly = snap.live === false
      // Why: an agent whose pane closes while you watch it downgrades from live
      // bytes to a history frame. Rebuild rather than reuse — the live
      // terminal's input wiring must not outlive the PTY it typed into.
      if (terminal && terminalReadOnly !== readOnly) {
        userInputDisposable?.dispose()
        userInputDisposable = null
        disposeImeNativeTextBridge()
        disposeTerminalCompatibility?.()
        disposeTerminalCompatibility = null
        disposeKeyHandler?.()
        disposeKeyHandler = null
        terminal.dispose()
        terminal = null
        terminalRef.current = null
      }
      if (!terminal) {
        terminal = new Terminal(
          {
            ...buildPreviewTerminalOptions({
              settings: settingsRef.current,
              terminalInput: terminalInputRef.current,
              macOptionIsMeta: macOptionAsAltRef.current === 'true',
              theme: terminalTheme,
              themeMode: terminalMode,
              cols: clamp(snap.cols ?? FALLBACK_COLS, 2, 500),
              rows: clamp(snap.rows ?? FALLBACK_ROWS, 2, 200),
              scrollback: PREVIEW_SCROLLBACK_BUFFER_ROWS
            }),
            // Why: a history frame has no input target; this also prevents
            // xterm from encoding ordinary keystrokes.
            ...(readOnly ? { disableStdin: true } : {})
          }
        )
        try {
          terminal.open(container)
        } catch {
          terminal.dispose()
          terminal = null
          return
        }
        terminalReadOnly = readOnly
        terminalRef.current = terminal
        installTerminalCompatibility()
        if (!readOnly) {
          installInputRouting()
          installImeNativeTextBridge()
        }
        // Copy remains useful on a history frame. Paste is rejected inside the
        // paste helper before clipboard access or IPC, and other input has no
        // onData route when read-only.
        installKeyHandler()
      } else if (replaceExisting) {
        // Why: keep the old frame visible during capture, then atomically replace it once the authoritative snapshot arrives.
        terminal.resize(
          clamp(snap.cols ?? FALLBACK_COLS, 2, 500),
          clamp(snap.rows ?? FALLBACK_ROWS, 2, 200)
        )
        terminal.reset()
      }
      replayPreviewConnectionSnapshot({
        snapshot: snap,
        replay: connection.replay,
        kittyKeyboardModes,
        write: (chunk, live) => writeReplayed(chunk, undefined, live)
      })
      for (const payload of pendingLivePayloads.splice(0)) {
        writeLive(payload)
      }
      if (connection.resyncRequired) {
        refreshAgain = false
        // Why: sustained output can overflow every capture; delay retries so recovery cannot spin two serializations per event-loop turn.
        writeReplayed('', () => {
          if (disposed || retryTimer) {
            return
          }
          retryTimer = setTimeout(() => {
            retryTimer = null
            requestRefresh()
          }, RESYNC_RETRY_DELAY_MS)
        })
      } else if (refreshAgain) {
        refreshAgain = false
        // Queue behind every replay write so replacement never clears a half-parsed frame.
        writeReplayed('', requestRefresh)
      }
      scheduleFit()
      if (readOnly) {
        // No PTY to resize into the dialog's box, and no input to catch.
        return
      }
      gridClaim.schedule()
      terminal.focus()
    }

    const setup = async (replaceExisting = false): Promise<void> => {
      if (refreshInFlight) {
        refreshAgain = true
        return
      }
      refreshInFlight = true
      const connection = await window.api.terminalPreview.connect(ptyId, {
        scrollbackRows: PREVIEW_SCROLLBACK_ROWS
      })
      if (disposed) {
        return
      }
      const snap = connection.snapshot
      if (!snap) {
        refreshInFlight = false
        setPtyGone(true)
        offData?.()
        offData = null
        userInputDisposable?.dispose()
        userInputDisposable = null
        disposeImeNativeTextBridge()
        disposeTerminalCompatibility?.()
        disposeTerminalCompatibility = null
        disposeKeyHandler?.()
        disposeKeyHandler = null
        terminal?.dispose()
        terminal = null
        terminalRef.current = null
        void window.api.terminalPreview.unsubscribe(ptyId)
        return
      }
      refreshInFlight = false
      setHistorical(snap.live === false)
      if (!connection.resyncRequired && retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      replayConnection(connection, replaceExisting, () => void setup(true))
    }

    const disposeAppMenuClipboard = installPreviewTerminalAppMenuClipboard({
      container,
      getTerminal: () => terminal,
      pasteClipboardText
    })

    offData = window.api.terminalPreview.onData((payload) => {
      if (payload.ptyId !== ptyId) {
        return
      }
      if (payload.type === 'resync') {
        void setup(true)
        return
      }
      writeLive(payload)
    })

    void setup()

    return () => {
      disposed = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      gridClaim.dispose()
      boxResizeObserver?.disconnect()
      disposeAppMenuClipboard()
      offData?.()
      userInputDisposable?.dispose()
      disposeImeNativeTextBridge()
      disposeTerminalCompatibility?.()
      disposeKeyHandler?.()
      void window.api.terminalPreview.unsubscribe(ptyId)
      terminal?.dispose()
      terminalRef.current = null
    }
  }, [ptyId, terminalTheme, terminalMode])

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
  }, [settings, macOptionAsAlt])

  return (
    // Why: a size FIXED by the viewport (not shrink-to-fit) + overflow-hidden
    // keeps the dialog stable no matter how wide/tall the pane's serialized
    // buffer is. The terminal keeps the pane's true dimensions and is scaled/
    // clipped to fit; fitToBox anchors whichever end keeps the cursor in view.
    <div
      className={cn(
        'relative flex h-[calc(100vh-140px)] w-full flex-col gap-1.5 overflow-hidden bg-background p-1.5',
        className
      )}
      style={terminalTheme?.background ? { backgroundColor: terminalTheme.background } : undefined}
    >
      {ptyGone ? (
        <div className="absolute inset-0 flex items-center justify-center px-2.5 py-8 text-center text-[11px] text-muted-foreground">
          {translate(
            'dashboardPopout.terminal.closed',
            "No live terminal — this agent's pane has closed."
          )}
        </div>
      ) : null}
      {historical ? (
        <div
          role="status"
          className="flex shrink-0 items-start gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-1 text-[11px] text-amber-700 dark:text-amber-300"
        >
          <History className="mt-px size-3 shrink-0" aria-hidden />
          <span>
            {translate(
              'dashboardPopout.terminal.historical',
              "Showing this pane's last saved frame — it isn't attached right now. Open the worktree to resume it."
            )}
          </span>
        </div>
      ) : null}
      <div
        aria-hidden={ptyGone || undefined}
        className={cn(
          'flex min-h-0 w-full flex-1 items-end overflow-hidden',
          ptyGone && 'invisible'
        )}
      >
        <div ref={containerRef} className="origin-bottom-left" />
      </div>
    </div>
  )
}
