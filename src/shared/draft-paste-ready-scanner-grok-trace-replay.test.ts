// Replay alt-screen and inline grok startup captures: ~12Hz logo shimmer defeats the 1.5s quiet window, causing 8s timeout delays/dropped drafts. Preserve both marker and quiet-floor paths.
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

/** Replay caller timer semantics: re-arm quiet requests, cancel on earlier chunks, and let hard timeout outrank late markers. Null means timeout; main drops that draft. Mirrors agent-draft-readiness.ts/orca-runtime.ts. */
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
  it('reports readiness within the first second of the alternate-screen trace', () => {
    const readyAt = replayReadyAtMs('grok-composer-prompt', GROK_STARTUP_PTY_TRACE)
    expect(readyAt).not.toBeNull()
    expect(readyAt).toBeLessThan(1000)
  })

  it('never settles the quiet window under the shimmering logo (the old behavior)', () => {
    // The capture continues 10s; no quiet readiness means the 8s caller timeout wins.
    expect(replayReadyAtMs('render-quiet-after-bracketed-paste', GROK_STARTUP_PTY_TRACE)).toBeNull()
  })

  it('reports readiness on the frame that paints the composer box', () => {
    const composerFrame = GROK_STARTUP_PTY_TRACE.find((chunk) => chunk.data?.includes('❯'))
    expect(composerFrame).toBeDefined()
    expect(replayReadyAtMs('grok-composer-prompt', GROK_STARTUP_PTY_TRACE)).toBe(composerFrame?.t)
  })
})

describe('grok startup trace replay (inline mode, no alternate screen)', () => {
  it('arms a quiet window before the inline trace reaches the modeled timeout', () => {
    // Inline grok emits no 1049h; retain a separate quiet anchor or main would drop the issue-URL draft.
    const readyAt = replayReadyAtMs('grok-composer-prompt', GROK_INLINE_STARTUP_PTY_TRACE)
    expect(readyAt).not.toBeNull()
    expect(readyAt).toBeLessThan(HARD_TIMEOUT_MS)
  })

  it('matches the default signal timing for the inline trace', () => {
    expect(replayReadyAtMs('grok-composer-prompt', GROK_INLINE_STARTUP_PTY_TRACE)).toBe(
      replayReadyAtMs('render-quiet-after-bracketed-paste', GROK_INLINE_STARTUP_PTY_TRACE)
    )
  })
})
