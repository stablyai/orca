/**
 * Issue #8335 — Terminal stuck (mouse motion echoed as literal input) after
 * backgrounding Orca while Claude Code's external editor is open.
 *
 * Causal chain:
 * 1. buildRehydrateSequences re-arms mouse modes from TerminalMouseModeMirror
 *    (including any-event ?1003 + SGR ?1006 that Claude armed before $EDITOR).
 * 2. On reattach, when the title still classifies as a live agent,
 *    shouldPreserveAgentReattachModes() → true → reattachReplayResetSequence
 *    uses buildPostReplayLiveAgentReattachReset, which deliberately omits
 *    RESET_MOUSE_REPORTING.
 * 3. During the external-editor wait the title still reads as Claude, so mouse
 *    mode is preserved against a foreground that is not the agent TUI →
 *    motion reports print as literal `35;x;yM` (documented hazard in
 *    layout-serialization.ts).
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/terminal-pane/repro-8335-agent-editor-mouse-preserve.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_MOUSE_REPORTING,
  buildPostReplayLiveAgentReattachReset
} from './layout-serialization'
import { buildRehydrateSequences } from '../../../../main/daemon/terminal-mode-rehydrate-sequences'
import type { TerminalModes } from '../../../../main/daemon/types'

const ptySource = readFileSync(join(__dirname, 'pty-connection.ts'), 'utf8')
const layoutSource = readFileSync(join(__dirname, 'layout-serialization.ts'), 'utf8')
const rehydrateSource = readFileSync(
  join(__dirname, '../../../../main/daemon/terminal-mode-rehydrate-sequences.ts'),
  'utf8'
)

describe('#8335 live-agent reattach preserves mouse modes (external editor hazard)', () => {
  it('rehydrate re-arms any-event + SGR mouse from last-observed modes', () => {
    const modes: TerminalModes = {
      alternateScreen: false,
      bracketedPaste: false,
      applicationCursor: false,
      mouseTracking: true,
      mouseTrackingMode: 'any',
      sgrMouseMode: true,
      sgrMousePixelsMode: false
    }
    const seq = buildRehydrateSequences(modes)
    expect(seq).toContain('\x1b[?1003h')
    expect(seq).toContain('\x1b[?1006h')
    expect(rehydrateSource).toMatch(/case 'any':\s*seqs\.push\('\\x1b\[\?1003h'\)/)
  })

  it('live-agent reattach reset omits RESET_MOUSE_REPORTING; shell path includes it', () => {
    expect(POST_REPLAY_REATTACH_RESET).toContain(RESET_MOUSE_REPORTING)
    expect(POST_REPLAY_LIVE_AGENT_REATTACH_RESET).not.toContain(RESET_MOUSE_REPORTING)
    expect(buildPostReplayLiveAgentReattachReset('agent frame')).toBe(
      POST_REPLAY_LIVE_AGENT_REATTACH_RESET
    )
    expect(buildPostReplayLiveAgentReattachReset('agent frame')).not.toContain(
      RESET_MOUSE_REPORTING
    )
  })

  it('pty-connection gates full mouse reset on shouldPreserveAgentReattachModes', () => {
    expect(ptySource).toMatch(
      /const reattachReplayResetSequence = \(payload: string\): string => \{\s*return shouldPreserveAgentReattachModes\(\)\s*\?\s*buildPostReplayLiveAgentReattachReset\(payload\)\s*:\s*POST_REPLAY_REATTACH_RESET/s
    )
    // Title/status still counts as agent-owned → preserve modes during editor wait
    expect(ptySource).toMatch(
      /const shouldPreserveAgentReattachModes = \(\): boolean => \{\s*\/\/ Why: ordinary shells can inherit stale[\s\S]*return hasLiveAgentReattachSignal\(\)/s
    )
  })

  it('documents the plain-shell mouse-echo hazard that this path recreates', () => {
    expect(layoutSource).toMatch(/35;x;yM/)
    expect(layoutSource).toMatch(/Live agents keep mouse modes via/)
  })
})
