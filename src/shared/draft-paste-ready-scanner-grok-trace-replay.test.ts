// Replays recorded grok startup PTY streams through the readiness scanner and
// asserts when each signal would have delivered the launch draft.
//
// The bug this covers: grok shimmers its welcome logo at ~12fps from startup
// until the session opens, so the default quiet window (1.5s of silence after
// DECSET 2004) never settles. Draft delivery fell through to the caller's 8s
// hard timeout, which is why pasting a GitHub issue URL into a fresh grok
// worktree felt frozen next to Claude's argv prefill.
//
// Two traces, because grok has two rendering modes and the fix must not trade
// one for the other: the default alternate-screen mode (fast marker path) and
// the inline mode that emits no alt-screen switch (quiet-window floor).
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from './tui-agent-config'
import {
  GROK_STARTUP_PTY_TRACE,
  type GrokStartupTraceChunk
} from './__fixtures__/grok-startup-pty-trace'
import { GROK_INLINE_STARTUP_PTY_TRACE } from './__fixtures__/grok-inline-startup-pty-trace'

const QUIET_WINDOW_MS = 1500
const HARD_TIMEOUT_MS = 8000

function chunkData(chunk: GrokStartupTraceChunk): string {
  return chunk.data ?? 'x'.repeat(chunk.bytes ?? 0)
}

/**
 * Replay `trace` against `signal` and return the ms offset at which the caller
 * would have pasted — the marker frame, or the first quiet window that elapses
 * without another chunk. `null` means the caller's hard timeout wins, which for
 * the main-process path means the draft is dropped entirely.
 *
 * Mirrors the callers in agent-draft-readiness.ts and orca-runtime.ts: the quiet
 * timer is re-armed on every chunk that asks for it, a chunk arriving before the
 * deadline cancels it, and the hard timeout outranks both — a marker that lands
 * after it is too late for the real waiters, which have already settled.
 */
function replayReadyAtMs(
  signal: DraftPasteReadySignal,
  trace: GrokStartupTraceChunk[]
): number | null {
  const scanner = createDraftPasteReadyScanner(signal)
  let quietDeadline: number | null = null
  for (const [index, chunk] of trace.entries()) {
    const settledAt =
      quietDeadline !== null ? Math.min(quietDeadline, HARD_TIMEOUT_MS) : HARD_TIMEOUT_MS
    if (chunk.t >= settledAt) {
      return quietDeadline !== null && quietDeadline <= HARD_TIMEOUT_MS ? quietDeadline : null
    }
    const scanned = scanner.observe(chunkData(chunk))
    if (scanned.ready) {
      return chunk.t
    }
    quietDeadline = scanned.armQuietTimer ? chunk.t + QUIET_WINDOW_MS : quietDeadline
    if (index === trace.length - 1 && quietDeadline !== null && quietDeadline < HARD_TIMEOUT_MS) {
      return quietDeadline
    }
  }
  return null
}

describe('grok startup trace replay (alternate-screen mode)', () => {
  it('delivers on the composer frame instead of waiting out the hard timeout', () => {
    const readyAt = replayReadyAtMs('grok-composer-prompt', GROK_STARTUP_PTY_TRACE)
    expect(readyAt).not.toBeNull()
    expect(readyAt).toBeLessThan(1000)
  })

  it('never settles the quiet window under the shimmering logo (the old behavior)', () => {
    // The recording runs 10s past launch; the default signal reaches the end
    // still waiting, so delivery only happened at the caller's 8s hard timeout.
    expect(replayReadyAtMs('render-quiet-after-bracketed-paste', GROK_STARTUP_PTY_TRACE)).toBeNull()
  })

  it('fires on the same frame that paints the composer box', () => {
    const composerFrame = GROK_STARTUP_PTY_TRACE.find((chunk) => chunk.data?.includes('❯'))
    expect(composerFrame).toBeDefined()
    expect(replayReadyAtMs('grok-composer-prompt', GROK_STARTUP_PTY_TRACE)).toBe(composerFrame?.t)
  })
})

describe('grok startup trace replay (inline mode, no alternate screen)', () => {
  it('still delivers through the quiet window when the marker never anchors', () => {
    // Why: inline grok emits no \x1b[?1049h, so the composer glyph never counts.
    // Anchoring the quiet window on the alt-screen switch too would leave this
    // launch with NO delivery path — orca-runtime drops the draft when readiness
    // resolves null, so the issue URL would vanish instead of arriving late.
    const readyAt = replayReadyAtMs('grok-composer-prompt', GROK_INLINE_STARTUP_PTY_TRACE)
    expect(readyAt).not.toBeNull()
    expect(readyAt).toBeLessThan(HARD_TIMEOUT_MS)
  })

  it('matches the default signal exactly, so inline launches keep their old timing', () => {
    expect(replayReadyAtMs('grok-composer-prompt', GROK_INLINE_STARTUP_PTY_TRACE)).toBe(
      replayReadyAtMs('render-quiet-after-bracketed-paste', GROK_INLINE_STARTUP_PTY_TRACE)
    )
  })

  it('reports the hard timeout, not a late marker, once the waiters have settled', () => {
    // Guards the model above: the real waiters resolve at 8s, so a marker landing
    // after that must not be reported as a delivery time.
    const lateMarker: GrokStartupTraceChunk[] = [
      { t: 0, data: '\x1b[?1049h' },
      { t: 8500, data: '\x1b[38;2;200;200;200m❯ ' }
    ]
    expect(replayReadyAtMs('grok-composer-prompt', lateMarker)).toBeNull()
  })

  it('records a startup with no alternate-screen switch', () => {
    // Guards the fixture itself: if a future re-recording captures alt-screen
    // output, the inline assertions above would silently stop testing inline.
    expect(GROK_INLINE_STARTUP_PTY_TRACE.some((chunk) => chunk.data?.includes('\x1b[?1049h'))).toBe(
      false
    )
    expect(GROK_INLINE_STARTUP_PTY_TRACE.some((chunk) => chunk.data?.includes('❯'))).toBe(true)
  })
})
