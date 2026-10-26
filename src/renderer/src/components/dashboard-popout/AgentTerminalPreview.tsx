import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ITheme, Terminal } from '@xterm/xterm'
import { useShallow } from 'zustand/react/shallow'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { replayPreviewConnectionSnapshot } from './preview-terminal-snapshot-replay'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import {
  buildPreviewAppearanceOptions,
  buildPreviewTerminalOptions,
  previewAdvertisesKittyKeyboard
} from './preview-terminal-options'
import { syncPreviewTerminalLigatures } from './preview-terminal-ligatures'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'
import { terminalPreviewUnavailableMessage } from './terminal-preview-unavailable-message'
import { getBuiltinTheme, resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { createPreviewGridClaim } from './preview-grid-claim'
import { createPreviewBoxFit } from './preview-terminal-box-fit'
import {
  openStandaloneTerminal,
  type StandaloneTerminal
} from '../standalone-terminal/open-standalone-terminal'
import type { TerminalPreviewDataPayload } from '../../../../shared/terminal-preview'
import { terminalPreviewApiFor } from './terminal-preview-api'

const PREVIEW_SCROLLBACK_ROWS = 24
// Preview snapshots bound history; pane scrollback would only cost memory.
const PREVIEW_SCROLLBACK_BUFFER_ROWS = 1000
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24
const RESYNC_RETRY_DELAY_MS = 150

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Claim the dialog’s grid, retaining real PTY dimensions when another owner requires scaling; stream input/output through a DOM renderer without WebGL. */
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
  // Read live settings without terminal remount, PTY reconnect or snapshot repaint.
  const settingsRef = useRef(settings)
  const macOptionAsAltRef = useRef(macOptionAsAlt)
  const terminalInputRef = useRef(terminalInput)
  const { terminalTheme: composedTheme, terminalMode } = useMemo(() => {
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
  // Settings arrive as cloned snapshots; compare theme values before reconnecting.
  const retainTheme = useShallow((theme: ITheme | null) => theme)
  const terminalTheme = retainTheme(composedTheme)
  const terminalMinimumContrastRatio = settings?.terminalMinimumContrastRatio
  // A null snapshot means the serializer cannot find the PTY; show unavailable instead of a blank terminal.
  const [ptyGone, setPtyGone] = useState(false)

  // Refresh committed refs in layout before xterm’s next native keydown; passive effects can miss a newly relayed input profile.
  useLayoutEffect(() => {
    settingsRef.current = settings
    macOptionAsAltRef.current = macOptionAsAlt
    terminalInputRef.current = terminalInput
  }, [settings, macOptionAsAlt, terminalInput])

  // Font changes retain the replay-driven fit, grid claim and input-owner reset.
  useEffect(() => {
    setPtyGone(false)
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    let standalone: StandaloneTerminal | null = null
    let terminal: Terminal | null = null
    let offData: (() => void) | null = null
    const previewApi = terminalPreviewApiFor(ptyId)
    // Why one read: the xterm's advertisement and its mirror must never disagree.
    const mountTerminalInput = terminalInputRef.current
    // Parse the same output as the pane so input policy sees the TUI’s negotiated kitty flags.
    const kittyKeyboardModes = new TerminalKittyKeyboardModeTracker({
      kittyKeyboard: previewAdvertisesKittyKeyboard(mountTerminalInput)
    })
    let refreshInFlight = false
    let refreshAgain = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const pendingLivePayloads: Extract<TerminalPreviewDataPayload, { type: 'data' }>[] = []

    const boxFit = createPreviewBoxFit({ container, getTerminal: () => terminal })

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
            boxFit.schedule()
            gridClaim.schedule()
          })
    if (container.parentElement) {
      boxResizeObserver?.observe(container.parentElement)
    }
    boxResizeObserver?.observe(container)

    const writeReplayed = (chunk: string, onDone?: () => void, live = false): void => {
      standalone?.write(chunk, {
        live,
        onDone: () => {
          boxFit.schedule()
          onDone?.()
        }
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
            void previewApi.ack(ptyId, payload.bytes)
          }
        },
        true
      )
    }

    const replayConnection = (
      connection: Awaited<ReturnType<typeof previewApi.connect>>,
      replaceExisting: boolean,
      requestRefresh: () => void
    ): void => {
      const snap = connection.snapshot!
      if (!terminal) {
        standalone = openStandaloneTerminal({
          container,
          options: buildPreviewTerminalOptions({
            settings: settingsRef.current,
            terminalInput: mountTerminalInput,
            macOptionIsMeta: macOptionAsAltRef.current === 'true',
            theme: terminalTheme,
            themeMode: terminalMode,
            cols: clamp(snap.cols ?? FALLBACK_COLS, 2, 500),
            rows: clamp(snap.rows ?? FALLBACK_ROWS, 2, 200),
            scrollback: PREVIEW_SCROLLBACK_BUFFER_ROWS
          }),
          kittyKeyboardModes,
          sessionKey: ptyId,
          sendInput: (data) => previewApi.input(ptyId, data),
          answersQueries: false,
          getSettings: () => settingsRef.current,
          getMacOptionAsAlt: () => macOptionAsAltRef.current,
          getTerminalInput: () => terminalInputRef.current
        })
        if (!standalone) {
          return
        }
        terminal = standalone.terminal
        terminalRef.current = terminal
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
      boxFit.schedule()
      gridClaim.schedule()
      terminal.focus()
    }

    const releaseTerminal = (): void => {
      offData?.()
      offData = null
      standalone?.dispose()
      standalone = null
      terminal = null
      terminalRef.current = null
      void previewApi.unsubscribe(ptyId)
    }

    const setup = async (replaceExisting = false): Promise<void> => {
      if (refreshInFlight) {
        refreshAgain = true
        return
      }
      refreshInFlight = true
      // Why: a failed or absent transport must show the unavailable message, not a blank dialog.
      const connection = await previewApi
        .connect(ptyId, { scrollbackRows: PREVIEW_SCROLLBACK_ROWS })
        .catch(() => null)
      if (disposed) {
        return
      }
      if (!connection?.snapshot) {
        refreshInFlight = false
        setPtyGone(true)
        releaseTerminal()
        return
      }
      refreshInFlight = false
      if (!connection.resyncRequired && retryTimer) {
        clearTimeout(retryTimer)
        retryTimer = null
      }
      replayConnection(connection, replaceExisting, () => void setup(true))
    }

    offData = previewApi.onData((payload) => {
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
      boxFit.dispose()
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
      gridClaim.dispose()
      boxResizeObserver?.disconnect()
      releaseTerminal()
    }
  }, [
    ptyId,
    terminalTheme,
    terminalMode,
    terminalMinimumContrastRatio,
    settings?.terminalFontSize,
    settings?.terminalFontFamily,
    settings?.terminalFontWeight,
    settings?.terminalFontWeightBold,
    settings?.terminalLineHeight,
    settings?.terminalLigatures
  ])

  // Apply appearance and OS Option-as-Alt changes without reconnecting the PTY or repainting its snapshot.
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
    // Fix the box to the viewport so snapshot geometry cannot resize the dialog; fit/clip the true PTY frame at its cursor end.
    <div
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
        <div ref={containerRef} className="origin-bottom-left" />
      </div>
    </div>
  )
}
