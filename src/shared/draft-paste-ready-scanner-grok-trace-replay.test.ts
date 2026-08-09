// Replays a recorded grok startup PTY stream through the readiness scanner and
// asserts when each signal would have delivered the launch draft.
//
// The bug this covers: grok shimmers its welcome logo at ~12fps from startup
// until the session opens, so the default quiet window (1.5s of silence after
// DECSET 2004) never settles. Draft delivery fell through to the caller's 8s
// hard timeout, which is why pasting a GitHub issue URL into a fresh grok
// worktree felt frozen next to Claude's argv prefill.
//
// The trace is real output from `grok` in an Orca worktree; see the fixture's
// header for what was dropped from the marker-free animation frames.
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from './tui-agent-config'
import {
  GROK_STARTUP_PTY_TRACE,
  type GrokStartupTraceChunk
} from './__fixtures__/grok-startup-pty-trace'

const QUIET_WINDOW_MS = 1500
const HARD_TIMEOUT_MS = 8000

function chunkData(chunk: GrokStartupTraceChunk): string {
  return chunk.data ?? 'x'.repeat(chunk.bytes ?? 0)
}

/**
 * Replay the trace against `signal` and return the ms offset at which the
 * caller would have pasted — the marker frame, or the first quiet window that
 * elapses without another chunk. `null` means the caller's hard timeout wins.
 */
function replayReadyAtMs(signal: DraftPasteReadySignal): number | null {
  const scanner = createDraftPasteReadyScanner(signal)
  const chunks = GROK_STARTUP_PTY_TRACE
  let quietDeadline: number | null = null
  for (const [index, chunk] of chunks.entries()) {
    if (quietDeadline !== null && chunk.t >= quietDeadline) {
      return quietDeadline
    }
    const scanned = scanner.observe(chunkData(chunk))
    if (scanned.ready) {
      return chunk.t
    }
    quietDeadline = scanned.armQuietTimer ? chunk.t + QUIET_WINDOW_MS : quietDeadline
    if (index === chunks.length - 1 && quietDeadline !== null && quietDeadline < HARD_TIMEOUT_MS) {
      return quietDeadline
    }
  }
  return null
}

describe('grok startup trace replay', () => {
  it('delivers on the composer frame instead of waiting out the hard timeout', () => {
    const readyAt = replayReadyAtMs('grok-composer-prompt')
    expect(readyAt).not.toBeNull()
    expect(readyAt).toBeLessThan(1000)
  })

  it('never settles the quiet window under the shimmering logo (the old behavior)', () => {
    // The recording runs 10s past launch; the default signal reaches the end
    // still waiting, so delivery only happened at the caller's 8s hard timeout.
    expect(replayReadyAtMs('render-quiet-after-bracketed-paste')).toBeNull()
  })

  it('fires on the same frame that paints the composer box', () => {
    const composerFrame = GROK_STARTUP_PTY_TRACE.find((chunk) => chunk.data?.includes('❯'))
    expect(composerFrame).toBeDefined()
    expect(replayReadyAtMs('grok-composer-prompt')).toBe(composerFrame?.t)
  })
})
