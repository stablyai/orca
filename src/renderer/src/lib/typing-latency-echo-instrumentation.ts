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
  onWriteParsed?: (listener: () => void) => Disposable
  onRender?: (listener: () => void) => Disposable
}

export type ProbePane = {
  id?: number
  terminal?: TerminalLike
  container?: HTMLElement
  leafId?: string
}

type PendingKeystroke = {
  t0: number
  bytes: number
  writes: number
  parsedAt: number | null
}

export type EchoSample = {
  parseMs: number
  paintMs: number
  bytes: number
  writes: number
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

function oldestUnparsed(entry: InstrumentedPane): PendingKeystroke | null {
  return entry.pending.find((pending) => pending.parsedAt === null) ?? null
}

/** Returns how many pending keystrokes were dropped without an echo. */
export function recordKeystroke(entry: InstrumentedPane, now: number): number {
  let dropped = 0
  while (entry.pending.length > 0 && now - (entry.pending[0]?.t0 ?? now) > ECHO_TIMEOUT_MS) {
    entry.pending.shift()
    dropped += 1
  }
  while (entry.pending.length >= MAX_PENDING) {
    entry.pending.shift()
    dropped += 1
  }
  entry.pending.push({ t0: now, bytes: 0, writes: 0, parsedAt: null })
  return dropped
}

export function instrumentPaneEcho(
  pane: ProbePane,
  onSample: (sample: EchoSample) => void
): InstrumentedPane {
  const entry: InstrumentedPane = { pane, pending: [], disposables: [], restoreWrite: null }
  const terminal = pane.terminal
  if (!terminal) {
    return entry
  }

  // Why: xterm exposes no per-write byte counter, so the probe wraps write() for
  // the duration of sampling — this is how per-keystroke output volume (Codex
  // ~230-306 bytes vs grok ~66) becomes visible without a build change.
  const originalWrite = terminal.write
  if (typeof originalWrite === 'function') {
    const wrapped = (data: string | Uint8Array, callback?: () => void): void => {
      const pending = oldestUnparsed(entry)
      if (pending) {
        pending.writes += 1
        pending.bytes += typeof data === 'string' ? data.length : data.byteLength
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

  if (typeof terminal.onWriteParsed === 'function') {
    entry.disposables.push(
      terminal.onWriteParsed(() => {
        const pending = oldestUnparsed(entry)
        if (pending) {
          pending.parsedAt = performance.now()
        }
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
            writes: pending.writes
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
