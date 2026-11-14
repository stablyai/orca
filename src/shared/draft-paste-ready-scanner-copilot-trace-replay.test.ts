// Replay Copilot CLI startup: its loading spinner kept the 1.5s quiet window from settling until
// well after the composer accepted paste, so GitHub-task launch drafts arrived seconds late.
import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import type { DraftPasteReadySignal } from './agent-launch/catalog/tui-agent-config-types'
import {
  COPILOT_STARTUP_PTY_TRACE,
  COPILOT_TRUST_MENU_PTY_TRACE,
  type CopilotStartupTraceChunk
} from './__fixtures__/copilot-startup-pty-trace'

const QUIET_WINDOW_MS = 1500

/** First chunk time the scanner reports ready, or the quiet-window deadline it would settle on. */
function replay(
  signal: DraftPasteReadySignal,
  trace: CopilotStartupTraceChunk[]
): { readyAtMs: number | null; quietAtMs: number | null } {
  const scanner = createDraftPasteReadyScanner(signal)
  let quietDeadline: number | null = null
  for (const chunk of trace) {
    if (quietDeadline !== null && chunk.t >= quietDeadline) {
      return { readyAtMs: null, quietAtMs: quietDeadline }
    }
    const scanned = scanner.observe(chunk.data)
    if (scanned.ready) {
      return { readyAtMs: chunk.t, quietAtMs: null }
    }
    if (scanned.armQuietTimer) {
      quietDeadline = chunk.t + QUIET_WINDOW_MS
    }
  }
  return { readyAtMs: null, quietAtMs: quietDeadline }
}

describe('copilot-composer-prompt startup replay', () => {
  it('delivers on the composer row instead of after the loading spinner settles', () => {
    expect(replay('render-quiet-after-bracketed-paste', COPILOT_STARTUP_PTY_TRACE)).toEqual({
      readyAtMs: null,
      quietAtMs: 4083 + QUIET_WINDOW_MS
    })
    expect(replay('copilot-composer-prompt', COPILOT_STARTUP_PTY_TRACE).readyAtMs).toBe(2368)
  })

  it('does not take the trust menu pointer for the composer', () => {
    const scanner = createDraftPasteReadyScanner('copilot-composer-prompt')
    expect(COPILOT_TRUST_MENU_PTY_TRACE.some((chunk) => chunk.data.includes('❯ 1. Yes'))).toBe(true)
    expect(COPILOT_TRUST_MENU_PTY_TRACE.some((chunk) => scanner.observe(chunk.data).ready)).toBe(
      false
    )
  })

  it('ignores a rule-and-pointer shell prompt outside the alt screen', () => {
    const scanner = createDraftPasteReadyScanner('copilot-composer-prompt')
    expect(scanner.observe(`\x1b[?2004h${'─'.repeat(40)}\r\n❯ `)).toEqual({
      ready: false,
      armQuietTimer: true
    })
  })
})
