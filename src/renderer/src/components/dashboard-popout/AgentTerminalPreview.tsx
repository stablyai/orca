import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import { replayPreviewConnectionSnapshot } from './preview-terminal-snapshot-replay'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { buildPreviewTerminalOptions } from './preview-terminal-options'
import {
  usePreviewTerminalAppearanceSync,
  usePreviewTerminalTheme
} from './use-preview-terminal-appearance-sync'
import { createPreviewClipboardPaster } from './preview-terminal-paste'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { createPreviewGridClaim } from './preview-grid-claim'
import { createPreviewBoxFit } from './preview-terminal-box-fit'
import { usePreviewWheelOverflow } from './preview-terminal-wheel-handoff'
import { createPreviewInputInstallers } from './preview-terminal-input-installers'
import { PreviewPhaseOverlay, type PreviewPhase } from './preview-terminal-phase-overlay'
import { cancelPreviewDetach, queuePreviewDetach } from './preview-detach-batch'
import { createPreviewSnapshotUnavailableRetry } from './preview-snapshot-unavailable-retry'
import { previewSnapshotGrid } from './preview-snapshot-grid'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../../../shared/terminal-preview'
import type { AgentTerminalPreviewProps } from './agent-terminal-preview-props'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

const PREVIEW_SCROLLBACK_ROWS = 24
// Why: main only ever serializes PREVIEW_SCROLLBACK_ROWS of history into this
// terminal, so the pane's user-configured scrollback would only cost memory.
const PREVIEW_SCROLLBACK_BUFFER_ROWS = 1000
const RESYNC_RETRY_DELAY_MS = 150
// A fallback-sourced snapshot that does not carry the granted grid is re-asked
// this many times (main's emulator can lag one seed behind a claim on a fresh
// pty); a mismatch that survives the re-ask is the PTY's real grid.
const STALE_GRID_SNAPSHOT_RETRIES = 1
const STALE_GRID_SNAPSHOT_RETRY_MS = 300

// Why per mount: one window may show the same pty twice (a grid card and the
// dialog it opens); main keys each preview's stream, acks and claim by this id.
let surfaceCounter = 0
const nextSurfaceId = (): string => `preview-surface-${++surfaceCounter}`

/**
 * Live interactive view of an agent's terminal, streaming from the main
 * process's per-PTY headless emulator. On open it claims the PTY grid for the
 * dialog's own box (see createPreviewGridClaim), so the terminal renders
 * properly sized rather than scaled. The terminal itself is always created at
 * the PTY's REAL cols/rows, and when someone else owns the grid (a phone, a
 * host reclaim) createPreviewBoxFit scales the oversized frame down. Keystrokes
 * pass through to the PTY; DOM renderer so it never grabs a WebGL context.
 */
export function AgentTerminalPreview({
  ptyId,
  terminalInput = null,
  fontSize,
  fitAxis,
  autoFocus = true,
  focusRef,
  detachBatched = false,
  onWheelOverflow,
  wheelTarget,
  onPtyGone,
  className
}: AgentTerminalPreviewProps): React.JSX.Element {
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
  const fontSizeRef = useRef(fontSize)
  const autoFocusRef = useRef(autoFocus)
  const onPtyGoneRef = useRef(onPtyGone)
  const { terminalTheme, terminalMode } = usePreviewTerminalTheme(settings, systemPrefersDark)
  const [mountSurfaceId] = useState(nextSurfaceId)
  const surfaceIdRef = useRef(mountSurfaceId)
  // A null snapshot means no serializer knows this pty (it died or was never
  // spawned this session) — say so instead of painting a silent blank terminal.
  const [ptyGone, setPtyGone] = useState(false)
  const [phase, setPhase] = useState<PreviewPhase>('connecting')
  const scheduleFitRef = useRef<(() => void) | null>(null)
  const gridClaimScheduleRef = useRef<(() => void) | null>(null)

  // Why: refs are seeded at first render and refreshed on commit — assigning
  // during render trips react-compiler. Layout, not passive: xterm's keydown is
  // a native listener, so React would not flush a passive effect before the
  // next keystroke and a just-relayed profile could miss it.
  useLayoutEffect(() => {
    settingsRef.current = settings
    macOptionAsAltRef.current = macOptionAsAlt
    terminalInputRef.current = terminalInput
    fontSizeRef.current = fontSize
    autoFocusRef.current = autoFocus
    onPtyGoneRef.current = onPtyGone
  }, [settings, macOptionAsAlt, terminalInput, fontSize, autoFocus, onPtyGone])

  useEffect(() => {
    setPtyGone(false)
    setPhase('connecting')
    const container = containerRef.current
    if (!container) {
      return
    }
    let disposed = false
    let terminal: Terminal | null = null
    let offData: (() => void) | null = null
    // Why: mirrors the pane's tracker — the policy needs the flags the TUI
    // negotiated, and this preview parses the same output stream the pane does.
    const kittyKeyboardModes = new TerminalKittyKeyboardModeTracker()
    let refreshInFlight = false
    let refreshAgain = false
    let hasAutoFocused = false
    let retryTimer: number | null = null
    let staleGridRetries = 0
    const pendingLivePayloads: Extract<TerminalPreviewDataPayload, { type: 'data' }>[] = []

    // A remount within the same frame beats a queued release: no host reclaim,
    // no re-claim — and it must keep the surface id main still holds open.
    const reclaimedSurfaceId = detachBatched ? cancelPreviewDetach(ptyId) : null
    if (reclaimedSurfaceId) {
      surfaceIdRef.current = reclaimedSurfaceId
    }
    const surfaceId = surfaceIdRef.current
    const boxFit = createPreviewBoxFit({ container, getTerminal: () => terminal, fitAxis })
    const scheduleFit = boxFit.schedule
    scheduleFitRef.current = scheduleFit

    const gridClaim = createPreviewGridClaim({
      ptyId,
      surfaceId,
      container,
      getTerminal: () => terminal,
      // The applied grid is when the frame's true size is finally known, so
      // the scale-to-fit fallback must re-measure against it.
      onApplied: () => scheduleFit()
    })
    gridClaimScheduleRef.current = gridClaim.schedule
    if (focusRef) {
      focusRef.current = () => terminalRef.current?.focus()
    }

    // Box growth/shrink (window resize) and screen growth/shrink (a font size
    // change re-laying out xterm) both change the reachable grid. No rect
    // guard here: the claim already dedupes by target, and gating on the box
    // alone is what left cards at their old columns after a zoom — the box is
    // unchanged, and the font-change claim measured before xterm reflowed.
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
    let livePending = false
    // Why one frame later: the last replay write is parsed but not yet laid
    // out when its callback fires; lifting the veil there shows the old frame.
    const goLive = (): void => {
      livePending = false
      requestAnimationFrame(() => {
        if (!disposed && !snapshotRetry.isUnavailable()) {
          setPhase('live')
        }
      })
    }
    const markLiveWhenReplayDrains = (): void => {
      livePending = true
      if (replayDepth === 0) {
        goLive()
      }
    }
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
        if (replayDepth === 0 && livePending) {
          goLive()
        }
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
            void window.api.terminalPreview.ack(ptyId, payload.bytes, surfaceId)
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
      isDisposed: () => disposed
    })

    const inputInstallers = createPreviewInputInstallers({
      ptyId,
      getTerminal: () => terminal,
      kittyKeyboardModes,
      pasteClipboardText: (activeElement, source) => void pasteClipboardText(activeElement, source),
      getSettings: () => settingsRef.current ?? null,
      getMacOptionAsAlt: () => macOptionAsAltRef.current,
      getTerminalInput: () => terminalInputRef.current,
      getReplayDepth: () => replayDepth
    })

    const replayConnection = (
      connection: Awaited<ReturnType<typeof window.api.terminalPreview.connect>>,
      replaceExisting: boolean,
      requestRefresh: () => void
    ): void => {
      const snap = connection.snapshot!
      if (!terminal) {
        terminal = new Terminal(
          buildPreviewTerminalOptions({
            settings: settingsRef.current,
            terminalInput: terminalInputRef.current,
            macOptionIsMeta: macOptionAsAltRef.current === 'true',
            theme: terminalTheme,
            themeMode: terminalMode,
            fontSize: fontSizeRef.current,
            ...previewSnapshotGrid(snap),
            scrollback: PREVIEW_SCROLLBACK_BUFFER_ROWS
          })
        )
        try {
          terminal.open(container)
        } catch {
          terminal.dispose()
          terminal = null
          return
        }
        terminalRef.current = terminal
        inputInstallers.install(terminal)
        void document.fonts?.ready?.then?.(() => {
          if (!disposed) {
            scheduleFit()
            gridClaim.schedule()
          }
        })
      } else if (replaceExisting) {
        // Why: keep the old frame visible during capture, then atomically replace it once the authoritative snapshot arrives.
        // The veil goes up before the resize/reset so the half-parsed frame in
        // between is never the one on screen.
        setPhase('painting')
        const grid = previewSnapshotGrid(snap)
        terminal.resize(grid.cols, grid.rows)
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
          retryTimer = window.setTimeout(() => {
            retryTimer = null
            requestRefresh()
          }, RESYNC_RETRY_DELAY_MS)
        })
      } else if (refreshAgain) {
        refreshAgain = false
        // Queue behind every replay write so replacement never clears a half-parsed frame.
        writeReplayed('', requestRefresh)
      }
      markLiveWhenReplayDrains()
      container.dataset.snapshotGrid = `${snap.cols ?? '?'}x${snap.rows ?? '?'}`
      container.dataset.snapshotSource = snap.source ?? 'unknown'
      // Why: the snapshot must carry the grid main granted. On a fresh pty the
      // emulator can still be seeding when the resync reconnects, so a
      // fallback source answers with the parked pane's stale geometry — and
      // nothing would ever ask again. A headless snapshot IS the PTY grid
      // (another viewer may have resized it), as is a mismatch that survives
      // the re-ask: adopt it so the scale-to-fit fallback measures reality.
      const granted = gridClaim.getApplied()
      const snapshotMatchesGrant =
        !granted || (snap.cols === granted.cols && snap.rows === granted.rows)
      if (snapshotMatchesGrant) {
        staleGridRetries = 0
      } else if (snap.source === 'headless' || staleGridRetries >= STALE_GRID_SNAPSHOT_RETRIES) {
        staleGridRetries = 0
        gridClaim.noteAppliedFromSnapshot(snap.cols, snap.rows)
      } else if (!retryTimer) {
        staleGridRetries += 1
        retryTimer = window.setTimeout(() => {
          retryTimer = null
          if (!disposed) {
            requestRefresh()
          }
        }, STALE_GRID_SNAPSHOT_RETRY_MS)
      }
      scheduleFit()
      // Why debounced, never immediate: this runs in the same task as the
      // resize()/reset() above, before xterm reflows its DOM, so measuring now
      // divides the OLD screen width by the NEW cols and overshoots the target
      // by the resize ratio — a claim/resync loop that never converges.
      gridClaim.schedule()
      // Why once: a resync must not yank the keyboard away from whichever
      // surface the user is typing in. With N previews on screen (session
      // grid), every re-focus stole input for a different pty.
      if (autoFocusRef.current && !hasAutoFocused) {
        hasAutoFocused = true
        terminal.focus()
      }
    }

    const snapshotRetry = createPreviewSnapshotUnavailableRetry({
      retry: () => {
        if (!disposed) {
          void setup(true)
        }
      },
      showUnavailable: () => setPhase('unavailable')
    })

    const setup = async (replaceExisting = false): Promise<void> => {
      if (refreshInFlight) {
        refreshAgain = true
        return
      }
      refreshInFlight = true
      const connection = await window.api.terminalPreview
        .connect(ptyId, {
          scrollbackRows: PREVIEW_SCROLLBACK_ROWS,
          surfaceId
        })
        .catch((): TerminalPreviewConnectResult => ({
          snapshot: null,
          replay: [],
          liveness: 'unverifiable'
        }))
      if (disposed) {
        return
      }
      const snap = connection.snapshot
      if (!snap) {
        refreshInFlight = false
        refreshAgain = false
        // An SSH pty has no snapshot to wait for: the provider serves none and the relay has no
        // snapshot RPC, so the notice (never an exit verdict) shows at once instead of retrying.
        if (connection.liveness !== 'exited' && parseAppSshPtyId(ptyId) === null) {
          snapshotRetry.noteUnavailable(terminal !== null)
          return
        }
        snapshotRetry.dispose()
        setPtyGone(true)
        onPtyGoneRef.current?.()
        offData?.()
        offData = null
        inputInstallers.dispose()
        terminal?.dispose()
        terminal = null
        terminalRef.current = null
        void window.api.terminalPreview.unsubscribe(ptyId, surfaceId)
        return
      }
      refreshInFlight = false
      snapshotRetry.noteAvailable()
      if (!connection.resyncRequired && retryTimer) {
        window.clearTimeout(retryTimer)
        retryTimer = null
      }
      replayConnection(connection, replaceExisting, () => void setup(true))
    }

    inputInstallers.installContainerClipboard(container)

    offData = window.api.terminalPreview.onData((payload) => {
      // A payload without a surface id is the implicit surface's; ours always has one.
      if (payload.ptyId !== ptyId || (payload.surfaceId ?? surfaceId) !== surfaceId) {
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
        window.clearTimeout(retryTimer)
      }
      snapshotRetry.dispose()
      gridClaim.dispose()
      boxResizeObserver?.disconnect()
      offData?.()
      inputInstallers.dispose()
      if (detachBatched) {
        queuePreviewDetach(ptyId, surfaceId)
      } else {
        void window.api.terminalPreview.unsubscribe(ptyId, surfaceId)
      }
      scheduleFitRef.current = null
      gridClaimScheduleRef.current = null
      if (focusRef) {
        focusRef.current = null
      }
      terminal?.dispose()
      terminalRef.current = null
    }
  }, [ptyId, terminalTheme, terminalMode, focusRef, fitAxis, detachBatched])

  usePreviewTerminalAppearanceSync({
    terminalRef,
    settings,
    macOptionAsAlt,
    fontSize,
    scheduleFitRef,
    gridClaimScheduleRef
  })

  usePreviewWheelOverflow({ containerRef, terminalRef, onWheelOverflow, wheelTarget })

  return (
    // Why: a size FIXED by the viewport (not shrink-to-fit) + overflow-hidden
    // keeps the dialog stable no matter how wide/tall the pane's serialized
    // buffer is. The terminal keeps the pane's true dimensions and is scaled/
    // clipped to fit; createPreviewBoxFit anchors the end that shows the cursor.
    <div
      className={cn(
        'relative h-[calc(100vh-140px)] w-full overflow-hidden bg-background p-1.5',
        className
      )}
      style={terminalTheme?.background ? { backgroundColor: terminalTheme.background } : undefined}
    >
      <PreviewPhaseOverlay
        phase={phase}
        ptyId={ptyId}
        ptyGone={ptyGone}
        background={terminalTheme?.background}
      />
      <div
        aria-hidden={ptyGone || undefined}
        className={cn('flex h-full w-full items-end overflow-hidden', ptyGone && 'invisible')}
      >
        <div ref={containerRef} className="origin-bottom-left" />
      </div>
    </div>
  )
}
