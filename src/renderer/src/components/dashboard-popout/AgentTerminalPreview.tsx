import { useEffect, useMemo, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { subscribeToTerminalUserInput } from '@/components/terminal-pane/terminal-user-input-signal'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield
} from '@/components/terminal-pane/terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from '@/components/terminal-pane/terminal-paste-runtime'
import { TERMINAL_PASTE_MAX_BYTES } from '@/components/terminal-pane/terminal-paste-limits'
import {
  installTerminalImeCompositionTracker,
  type TerminalImeCompositionTracker
} from '@/components/terminal-pane/terminal-ime-composition-tracker'
import {
  installTerminalImeNativeTextForwarder,
  type TerminalImeNativeTextForwarder
} from '@/components/terminal-pane/terminal-ime-native-text-forwarder'
import { getMacNativeTextInputSourceTracker } from '@/components/terminal-pane/terminal-ime-input-source'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { resolveTerminalMinimumContrastRatio } from '@/lib/terminal-contrast-correction'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { translate } from '@/i18n/i18n'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { installPreviewClipboardShortcuts } from './preview-clipboard-shortcuts'
import { createPreviewGridClaim } from './preview-grid-claim'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'

const PREVIEW_SCROLLBACK_ROWS = 24
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
 */
export function AgentTerminalPreview({ ptyId }: { ptyId: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((state) => state.settings)
  const systemPrefersDark = useSystemPrefersDark()
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
  // A null snapshot means no serializer knows this pty (it died or was never
  // spawned this session) — say so instead of painting a silent blank terminal.
  const [ptyGone, setPtyGone] = useState(false)

  useEffect(() => {
    setPtyGone(false)
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    let terminal: Terminal | null = null
    let offData: (() => void) | null = null
    let userInputDisposable: { dispose: () => void } | null = null
    let imeCompositionTracker: TerminalImeCompositionTracker | null = null
    let imeNativeTextForwarder: TerminalImeNativeTextForwarder | null = null
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
            gridClaim.schedule()
          })
    if (container.parentElement) {
      boxResizeObserver?.observe(container.parentElement)
    }
    boxResizeObserver?.observe(container)

    let replayDepth = 0
    const writeReplayed = (chunk: string, onDone?: () => void): void => {
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
      writeReplayed(payload.data, () => {
        if (!disposed) {
          void window.api.terminalPreview.ack(ptyId, payload.bytes)
        }
      })
    }

    const pasteClipboardText = async (
      activeElementAtDispatch: Element | null,
      source: 'keyboard' | 'app-menu'
    ): Promise<void> => {
      let text: string
      try {
        text = await window.api.ui.readClipboardText({ maxBytes: TERMINAL_PASTE_MAX_BYTES })
      } catch {
        return
      }
      const pasteTerminal = terminal
      if (!pasteTerminal || !text) {
        return
      }
      const targetIsCurrent = (): boolean =>
        !disposed &&
        terminal === pasteTerminal &&
        activeElementAtDispatch !== null &&
        document.activeElement === activeElementAtDispatch &&
        container.contains(activeElementAtDispatch)
      if (!targetIsCurrent()) {
        return
      }
      const platform = getShortcutPlatform()
      const plan = await planTerminalPasteWithYield({
        text,
        source,
        target: {
          kind: 'terminal',
          paneId: 0,
          leafId: ptyId,
          ptyId,
          runtime: resolveTerminalPasteRuntime({ platform, ptyId })
        },
        terminalBracketedPasteMode: pasteTerminal.modes.bracketedPasteMode
      })
      await executeTerminalPastePlan(plan, {
        // Why: stream large pastes so the renderer never emits one huge IPC payload.
        pasteText: (pasteText) => pasteTerminal.paste(pasteText),
        writePty: (data) => window.api.terminalPreview.input(ptyId, data),
        isTargetCurrent: targetIsCurrent,
        // Why: if focus changes mid-bracketed paste, the closing marker must still reach the live PTY.
        canContinue: () => true
      })
    }

    const disposeImeNativeTextBridge = (): void => {
      imeNativeTextForwarder?.dispose()
      imeNativeTextForwarder = null
      imeCompositionTracker?.dispose()
      imeCompositionTracker = null
    }

    // Why: xterm's kitty encoder can encode+cancel a printable keydown before
    // Chromium commits IME/native text, silently dropping the glyph (mirrors
    // TerminalPane's forwarder; macOS-only like the pane's install).
    const installImeNativeTextBridge = (): void => {
      if (!terminal || getShortcutPlatform() !== 'darwin') {
        return
      }
      // Why: prewarm the async input-source lookup before the first native-text key needs classification.
      const inputSourceTracker = getMacNativeTextInputSourceTracker()
      imeCompositionTracker = installTerminalImeCompositionTracker(terminal.element)
      imeNativeTextForwarder = installTerminalImeNativeTextForwarder({
        terminalElement: terminal.element,
        isComposing: () => imeCompositionTracker?.isActive() ?? false,
        sendInput: (data) => terminal?.input(data),
        getInputSourceFeatures: () => inputSourceTracker.getFeatures()
      })
    }

    const installClipboardShortcuts = (): void => {
      if (!terminal) {
        return
      }
      installPreviewClipboardShortcuts({
        terminal,
        claimImeKeyEvent: (event) => imeNativeTextForwarder?.claimKeyEvent(event) ?? false,
        pasteClipboardText: (activeElement, source) =>
          void pasteClipboardText(activeElement, source)
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
      if (!terminal) {
        terminal = new Terminal({
          ...buildDefaultTerminalOptions(),
          cols: clamp(snap.cols ?? FALLBACK_COLS, 2, 500),
          rows: clamp(snap.rows ?? FALLBACK_ROWS, 2, 200),
          theme: terminalTheme ?? undefined,
          minimumContrastRatio: resolveTerminalMinimumContrastRatio(
            terminalTheme?.background,
            terminalMode
          ),
          scrollback: 1000
        })
        try {
          terminal.open(container)
        } catch {
          terminal.dispose()
          terminal = null
          return
        }
        installInputRouting()
        installImeNativeTextBridge()
        installClipboardShortcuts()
      } else if (replaceExisting) {
        // Why: keep the old frame visible during capture, then atomically replace it once the authoritative snapshot arrives.
        terminal.resize(
          clamp(snap.cols ?? FALLBACK_COLS, 2, 500),
          clamp(snap.rows ?? FALLBACK_ROWS, 2, 200)
        )
        terminal.reset()
      }
      if (snap.scrollbackAnsi) {
        writeReplayed(snap.scrollbackAnsi)
      }
      if (snap.data) {
        writeReplayed(snap.data)
      }
      if (snap.pendingEscapeTailAnsi) {
        writeReplayed(snap.pendingEscapeTailAnsi)
      }
      for (const data of connection.replay) {
        writeReplayed(data)
      }
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
        terminal?.dispose()
        terminal = null
        void window.api.terminalPreview.unsubscribe(ptyId)
        return
      }
      refreshInFlight = false
      if (!connection.resyncRequired && retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      replayConnection(connection, replaceExisting, () => void setup(true))
    }

    // Why: the popout has no TerminalPane/useAppMenuPaste, so the Edit menu's
    // Cmd/Ctrl+V (routed to the focused window as ui:appMenuPaste) would
    // otherwise be dropped and paste would silently do nothing here.
    const offAppMenuPaste = window.api.ui.onAppMenuPaste(() => {
      const active = document.activeElement
      if (active && container.contains(active)) {
        void pasteClipboardText(active, 'app-menu')
      }
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
      offAppMenuPaste()
      offData?.()
      userInputDisposable?.dispose()
      disposeImeNativeTextBridge()
      void window.api.terminalPreview.unsubscribe(ptyId)
      terminal?.dispose()
    }
  }, [ptyId, terminalTheme, terminalMode])

  return (
    // Why: a size FIXED by the viewport (not shrink-to-fit) + overflow-hidden
    // keeps the dialog stable no matter how wide/tall the pane's serialized
    // buffer is. The terminal keeps the pane's true dimensions and is scaled/
    // clipped to fit; fitToBox anchors whichever end keeps the cursor in view.
    <div
      className="relative h-[calc(100vh-140px)] w-full overflow-hidden bg-background p-1.5"
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
      <div
        aria-hidden={ptyGone || undefined}
        className={cn('flex h-full w-full items-end overflow-hidden', ptyGone && 'invisible')}
      >
        <div ref={containerRef} className="origin-bottom-left" />
      </div>
    </div>
  )
}
