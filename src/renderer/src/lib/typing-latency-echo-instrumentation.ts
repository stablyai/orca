/**
 * Per-pane echo instrumentation for the devtools typing-latency probe.
 *
 * Mechanics mirror the E2E echo probe: keydown stamps t0, xterm's
 * onWriteParsed marks the echo parse, onRender marks the paint, and a bounded
 * pending QUEUE (never a single slot) keeps a slow echo from being silently
 * discarded. Attached only while the probe runs; detachPaneEcho restores
 * everything it wrapped.
 */
import { forEachLivePaneForDesyncSentinel } from '@/lib/pane-manager/pane-manager-registry'

type Disposable = { dispose: () => void }

type TerminalLike = {
  cols?: number
  rows?: number
  element?: HTMLElement | null
  buffer?: { active?: { type?: string; length?: number } }
  write?: (data: string | Uint8Array, callback?: () => void) => void
  onData?: (listener: (data: string) => void) => Disposable
  onWriteParsed?: (listener: () => void) => Disposable
  onRender?: (listener: () => void) => Disposable
}

export type ProbePane = {
  id?: number
  terminal?: TerminalLike
  container?: HTMLElement
  leafId?: string
}

/** 'ime' is a composed commit (compositionend); 'direct' is a plain keydown. */
export type KeystrokeSource = 'ime' | 'direct'

type PendingKeystroke = {
  t0: number
  source: KeystrokeSource
  bytes: number
  writes: number
  /** When xterm emitted the bytes toward the pty; null if it never did. */
  dispatchedAt: number | null
  parsedAt: number | null
  /** How many keystrokes the echoing write resolved alongside this one. */
  coalescing: number
}

export type EchoSample = {
  parseMs: number
  paintMs: number
  bytes: number
  writes: number
  source: KeystrokeSource
  /** How many keystrokes the echoing write resolved at once. */
  coalescing: number
  /**
   * Keystroke to the moment xterm handed the bytes toward the pty, so the rest
   * of the wait can be attributed to the host round trip rather than to the
   * renderer. -1 when no dispatch was seen (a preedit jamo sends nothing).
   */
  dispatchMs: number
}

export type InstrumentedPane = {
  pane: ProbePane
  pending: PendingKeystroke[]
  disposables: Disposable[]
  restoreWrite: (() => void) | null
}

/** An echo that has not parsed within this window is counted as unmatched, never as a sample. */
const ECHO_TIMEOUT_MS = 2000
const MAX_PENDING = 64

export function listProbePanes(): ProbePane[] {
  const panes: ProbePane[] = []
  try {
    forEachLivePaneForDesyncSentinel((_key, pane) => {
      panes.push(pane as ProbePane)
    })
  } catch {
    // Why: a mid-teardown manager must not prevent the probe from starting.
  }
  return panes
}

export function paneRootElement(pane: ProbePane): HTMLElement | null {
  return pane.container ?? pane.terminal?.element ?? null
}

export function findPaneOwningFocus<T extends { pane: ProbePane }>(
  entries: readonly T[]
): T | null {
  const focused = typeof document === 'undefined' ? null : document.activeElement
  if (!focused) {
    return null
  }
  return entries.find((entry) => paneRootElement(entry.pane)?.contains(focused) === true) ?? null
}

/**
 * Every keystroke still waiting for an echo.
 *
 * Why the whole set and not just the oldest: a TUI redraws on its own frame
 * clock, so typing faster than that clock puts several keystrokes into one
 * redraw. That redraw is what makes each of them visible, so it is their echo
 * and their byte cost alike. Crediting only the oldest left the rest pending
 * forever — the probe dropped most of a fast burst and kept exactly the entries
 * that had waited longest, reporting a p50 biased upward.
 */
function pendingAwaitingEcho(entry: InstrumentedPane): PendingKeystroke[] {
  return entry.pending.filter((pending) => pending.parsedAt === null)
}

/**
 * Marks the whole waiting set echoed, returning how many one write resolved.
 *
 * The count is stored per keystroke, not on the pane: a second write can parse
 * before the render that drains the first batch, and a shared slot would then
 * report the later batch's size for the earlier samples.
 */
function markPendingEcho(entry: InstrumentedPane, at: number): number {
  const waiting = pendingAwaitingEcho(entry)
  for (const pending of waiting) {
    pending.parsedAt = at
    pending.coalescing = waiting.length
  }
  return waiting.length
}

/** Returns how many pending keystrokes were dropped without an echo. */
export function recordKeystroke(
  entry: InstrumentedPane,
  now: number,
  source: KeystrokeSource
): number {
  let dropped = 0
  while (entry.pending.length > 0 && now - (entry.pending[0]?.t0 ?? now) > ECHO_TIMEOUT_MS) {
    entry.pending.shift()
    dropped += 1
  }
  while (entry.pending.length >= MAX_PENDING) {
    entry.pending.shift()
    dropped += 1
  }
  entry.pending.push({
    t0: now,
    source,
    bytes: 0,
    writes: 0,
    dispatchedAt: null,
    parsedAt: null,
    coalescing: 0
  })
  return dropped
}

export function instrumentPaneEcho(
  pane: ProbePane,
  onSample: (sample: EchoSample) => void
): InstrumentedPane {
  const entry: InstrumentedPane = {
    pane,
    pending: [],
    disposables: [],
    restoreWrite: null
  }
  const terminal = pane.terminal
  if (!terminal) {
    return entry
  }

  // Why: xterm exposes no per-write byte counter, so the probe wraps write() for
  // the duration of sampling — this is how per-echo output volume (Codex
  // ~230-306 bytes vs grok ~66) becomes visible without a build change.
  const originalWrite = terminal.write
  if (typeof originalWrite === 'function') {
    const wrapped = (data: string | Uint8Array, callback?: () => void): void => {
      const size = typeof data === 'string' ? data.length : data.byteLength
      // Coalesced keystrokes each report the whole echoing write; `coalescing`
      // on the sample says how many shared it, so the two divide.
      for (const pending of pendingAwaitingEcho(entry)) {
        pending.writes += 1
        pending.bytes += size
      }
      originalWrite.call(terminal, data, callback)
    }
    terminal.write = wrapped
    entry.restoreWrite = () => {
      if (terminal.write === wrapped) {
        terminal.write = originalWrite
      }
    }
  }

  // Why: an IME commit reaches the pty through terminal.input(), which lands on
  // this same emitter, so it stamps the moment the renderer is done with the
  // keystroke. Everything after it is host round trip, not renderer work.
  if (typeof terminal.onData === 'function') {
    entry.disposables.push(
      terminal.onData(() => {
        const now = performance.now()
        for (const pending of pendingAwaitingEcho(entry)) {
          pending.dispatchedAt ??= now
        }
      })
    )
  }
  if (typeof terminal.onWriteParsed === 'function') {
    entry.disposables.push(
      terminal.onWriteParsed(() => {
        markPendingEcho(entry, performance.now())
      })
    )
  }
  if (typeof terminal.onRender === 'function') {
    entry.disposables.push(
      terminal.onRender(() => {
        const now = performance.now()
        while (entry.pending.length > 0 && entry.pending[0]?.parsedAt != null) {
          const pending = entry.pending.shift()
          if (!pending || pending.parsedAt == null) {
            continue
          }
          onSample({
            parseMs: pending.parsedAt - pending.t0,
            paintMs: now - pending.t0,
            bytes: pending.bytes,
            writes: pending.writes,
            source: pending.source,
            coalescing: pending.coalescing,
            dispatchMs: pending.dispatchedAt === null ? -1 : pending.dispatchedAt - pending.t0
          })
        }
      })
    )
  }
  return entry
}

export function detachPaneEcho(entry: InstrumentedPane): void {
  for (const disposable of entry.disposables) {
    try {
      disposable.dispose()
    } catch {
      // Why: a pane disposed mid-run already dropped its listeners.
    }
  }
  entry.disposables = []
  entry.restoreWrite?.()
  entry.restoreWrite = null
  entry.pending = []
}
