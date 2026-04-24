/* eslint-disable max-lines --
 * Why: agent title detection is intentionally table-driven in one place so the
 * supported title variants stay readable and regressions are easy to compare.
 */
import { describe, expect, it, test, vi } from 'vitest'
import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  getAgentLabel,
  isGeminiTerminalTitle,
  normalizeTerminalTitle,
  isExplicitAgentStatusFresh,
  mapAgentStatusStateToVisualStatus,
  formatAgentTypeLabel,
  agentTypeToIconAgent
} from './agent-status'
import { extractLastOscTitle } from '../components/terminal-pane/pty-transport'

describe('detectAgentStatusFromTitle', () => {
  it('returns null for empty string', () => {
    expect(detectAgentStatusFromTitle('')).toBeNull()
  })

  it('returns null for a title with no agent indicators', () => {
    expect(detectAgentStatusFromTitle('bash')).toBeNull()
    expect(detectAgentStatusFromTitle('vim myfile.ts')).toBeNull()
  })

  // --- Gemini symbols ---
  it('detects Gemini permission symbol ✋', () => {
    expect(detectAgentStatusFromTitle('✋ Gemini CLI')).toBe('permission')
  })

  it('detects Gemini working symbol ✦', () => {
    expect(detectAgentStatusFromTitle('✦ Gemini CLI')).toBe('working')
  })

  it('detects Gemini idle symbol ◇', () => {
    expect(detectAgentStatusFromTitle('◇ Gemini CLI')).toBe('idle')
  })

  it('detects Gemini silent working symbol ⏲', () => {
    expect(detectAgentStatusFromTitle('⏲  Working… (my-project)')).toBe('working')
  })

  it('Gemini permission takes precedence over working', () => {
    expect(detectAgentStatusFromTitle('✋✦ Gemini CLI')).toBe('permission')
  })

  // --- Braille spinner characters ---
  it('detects braille spinner ⠋ as working', () => {
    expect(detectAgentStatusFromTitle('⠋ Codex is thinking')).toBe('working')
  })

  it('detects braille spinner ⠙ as working', () => {
    expect(detectAgentStatusFromTitle('⠙ some task')).toBe('working')
  })

  it('detects braille spinner ⠹ as working', () => {
    expect(detectAgentStatusFromTitle('⠹ aider running')).toBe('working')
  })

  it('detects braille spinner ⠸ as working', () => {
    expect(detectAgentStatusFromTitle('⠸ process')).toBe('working')
  })

  it('detects braille spinner ⠼ as working', () => {
    expect(detectAgentStatusFromTitle('⠼ opencode')).toBe('working')
  })

  it('detects braille spinner ⠴ as working', () => {
    expect(detectAgentStatusFromTitle('⠴ loading')).toBe('working')
  })

  it('detects braille spinner ⠦ as working', () => {
    expect(detectAgentStatusFromTitle('⠦ claude')).toBe('working')
  })

  it('detects braille spinner ⠧ as working', () => {
    expect(detectAgentStatusFromTitle('⠧ task')).toBe('working')
  })

  // --- Agent name keyword combos ---
  it('detects permission requests from agent titles', () => {
    expect(detectAgentStatusFromTitle('Claude Code - action required')).toBe('permission')
  })

  it('detects "permission" keyword with agent name', () => {
    expect(detectAgentStatusFromTitle('codex - permission needed')).toBe('permission')
  })

  it('detects "waiting" keyword with agent name', () => {
    expect(detectAgentStatusFromTitle('gemini waiting for input')).toBe('permission')
  })

  it('detects "ready" keyword as idle', () => {
    expect(detectAgentStatusFromTitle('claude ready')).toBe('idle')
  })

  it('detects "idle" keyword as idle', () => {
    expect(detectAgentStatusFromTitle('codex idle')).toBe('idle')
  })

  it('detects "done" keyword as idle', () => {
    expect(detectAgentStatusFromTitle('aider done')).toBe('idle')
  })

  it('detects "working" keyword as working', () => {
    expect(detectAgentStatusFromTitle('claude working on task')).toBe('working')
  })

  it('detects "thinking" keyword as working', () => {
    expect(detectAgentStatusFromTitle('gemini thinking')).toBe('working')
  })

  it('detects "running" keyword as working', () => {
    expect(detectAgentStatusFromTitle('opencode running tests')).toBe('working')
  })

  // --- Claude Code title prefixes ---
  it('detects ". " prefix as working (Claude Code)', () => {
    expect(detectAgentStatusFromTitle('. claude')).toBe('working')
  })

  it('detects "* " prefix as idle (Claude Code)', () => {
    expect(detectAgentStatusFromTitle('* claude')).toBe('idle')
  })

  // --- Real Claude Code OSC titles ---
  // Claude Code sets title to task description, NOT "Claude Code"
  it('detects ✳ prefix as idle (Claude Code with task description)', () => {
    expect(detectAgentStatusFromTitle('✳ User acknowledgment and confirmation')).toBe('idle')
  })

  it('detects ✳ prefix as idle (Claude Code with agent name)', () => {
    expect(detectAgentStatusFromTitle('✳ Claude Code')).toBe('idle')
  })

  it('detects braille spinner as working (Claude Code with task description)', () => {
    expect(detectAgentStatusFromTitle('⠐ User acknowledgment and confirmation')).toBe('working')
  })

  it('detects braille spinner as working (Claude Code with agent name)', () => {
    expect(detectAgentStatusFromTitle('⠂ Claude Code')).toBe('working')
  })

  // --- Agent name alone defaults to idle ---
  it('returns idle for bare agent name "claude"', () => {
    expect(detectAgentStatusFromTitle('claude')).toBe('idle')
  })

  it('returns idle for bare agent name "codex"', () => {
    expect(detectAgentStatusFromTitle('codex')).toBe('idle')
  })

  it('returns idle for bare agent name "aider"', () => {
    expect(detectAgentStatusFromTitle('aider')).toBe('idle')
  })

  it('returns idle for bare agent name "opencode"', () => {
    expect(detectAgentStatusFromTitle('opencode')).toBe('idle')
  })

  it('detects Pi idle titles', () => {
    expect(detectAgentStatusFromTitle('π - my-project')).toBe('idle')
    expect(detectAgentStatusFromTitle('π - session-name - my-project')).toBe('idle')
  })

  // --- Case insensitivity ---
  it('is case-insensitive for agent names', () => {
    expect(detectAgentStatusFromTitle('CLAUDE')).toBe('idle')
    expect(detectAgentStatusFromTitle('Codex Working')).toBe('working')
  })

  // Why: `detectAgentStatusFromTitle` uses a substring-based `containsAgentName`
  // fallback, so a cwd-path containing an agent-name fragment without a strong
  // keyword or ". "/"* " prefix still falls through to the 'idle' branch. Pin
  // the behavior so a future tightening (or deliberate relaxation) of
  // `containsAgentName` is an explicit decision.
  it('still returns idle for cwd-path containing agent name (known containsAgentName gap)', () => {
    expect(detectAgentStatusFromTitle('~/codex-scratch')).toBe('idle')
    expect(detectAgentStatusFromTitle('~/codex already built')).toBe('idle')
  })
})

// Why: regression guard for the STRONG_WORKING_KEYWORDS_RE path-separator
// false positive. Before the lookarounds were widened to `[\w./\\-]`, a title
// like `~/codex/working` matched STRONG_WORKING_KEYWORDS_RE (because `/` is
// not in `[\w\-]`) and the function classified a plain path as 'working',
// driving spinners and agent counts off a shell cwd. The idle-side fallback
// at the bottom of `detectAgentStatusFromTitle` still returns 'idle' for
// agent-name-containing titles — that's the known `containsAgentName`
// substring gap documented in the test above — so the behavior this block
// pins is specifically "no path fragment is ever classified as 'working'."
describe('detectAgentStatusFromTitle path-separator rejection', () => {
  test('rejects working keywords adjacent to POSIX path separators', () => {
    expect(detectAgentStatusFromTitle('~/codex/working')).not.toBe('working')
    expect(detectAgentStatusFromTitle('~/codex/thinking')).not.toBe('working')
    expect(detectAgentStatusFromTitle('~/codex/running')).not.toBe('working')
  })

  test('rejects working keywords adjacent to Windows path separators', () => {
    expect(detectAgentStatusFromTitle('C:\\codex\\working')).not.toBe('working')
    expect(detectAgentStatusFromTitle('C:\\aider\\thinking')).not.toBe('working')
  })

  test('rejects working keywords adjacent to `.` separators', () => {
    expect(detectAgentStatusFromTitle('codex.working')).not.toBe('working')
    expect(detectAgentStatusFromTitle('aider.thinking')).not.toBe('working')
  })

  test('still accepts legitimate idle/working titles separated by whitespace', () => {
    expect(detectAgentStatusFromTitle('Codex done')).toBe('idle')
    expect(detectAgentStatusFromTitle('OpenCode ready')).toBe('idle')
    expect(detectAgentStatusFromTitle('Aider idle')).toBe('idle')
    expect(detectAgentStatusFromTitle('Codex working')).toBe('working')
    expect(detectAgentStatusFromTitle('Aider thinking')).toBe('working')
  })

  // Why: path separators only need to be blocked on the LEFT of the keyword
  // (where path fragments sit). Blocking them on the right would regress
  // legitimate sentence-style titles where a keyword is followed by `.`/`!`/`?`.
  test('still accepts keywords followed by trailing punctuation', () => {
    expect(detectAgentStatusFromTitle('Codex done.')).toBe('idle')
    expect(detectAgentStatusFromTitle('Aider idle!')).toBe('idle')
    expect(detectAgentStatusFromTitle('OpenCode ready?')).toBe('idle')
    expect(detectAgentStatusFromTitle('Codex working.')).toBe('working')
    expect(detectAgentStatusFromTitle('Aider thinking...')).toBe('working')
  })
})

describe('clearWorkingIndicators', () => {
  it('strips Claude Code ". " working prefix', () => {
    const cleared = clearWorkingIndicators('. claude')
    expect(cleared).toBe('claude')
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })

  it('strips braille spinner characters and working keywords', () => {
    const cleared = clearWorkingIndicators('⠋ Codex is thinking')
    expect(cleared).toBe('Codex is')
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })

  it('strips Gemini working symbol', () => {
    const cleared = clearWorkingIndicators('✦ Gemini CLI')
    expect(cleared).toBe('Gemini CLI')
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })

  it('strips Gemini silent working symbol ⏲', () => {
    const cleared = clearWorkingIndicators('⏲  Working… (my-project)')
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })

  it('returns original title if no working indicators found', () => {
    expect(clearWorkingIndicators('* claude')).toBe('* claude')
    expect(clearWorkingIndicators('Terminal 1')).toBe('Terminal 1')
  })

  // Why: clearWorkingIndicators must use the same hyphen/word-char-aware
  // boundary as STRONG_WORKING_KEYWORDS_RE (agent-detection.ts). A prior
  // implementation used plain `\b${keyword}\b` which — since `-` is a
  // non-word char — would strip "working" out of "codex is-working-cap"
  // even though detectAgentStatusFromTitle correctly refuses to classify
  // that title as 'working'. The clearer and detector must stay symmetric.
  it('does not strip working keywords inside hyphenated compounds', () => {
    expect(clearWorkingIndicators('codex is-working-cap')).toBe('codex is-working-cap')
    expect(clearWorkingIndicators('claude reworking diff')).toBe('claude reworking diff')
    expect(clearWorkingIndicators('codex overthinking it')).toBe('codex overthinking it')
  })

  it('still strips working keywords at whitespace boundaries', () => {
    const cleared = clearWorkingIndicators('Codex working on tests')
    expect(cleared).not.toMatch(/\bworking\b/)
    expect(detectAgentStatusFromTitle(cleared)).not.toBe('working')
  })
})

describe('normalizeTerminalTitle', () => {
  it('collapses Gemini working titles to a stable label', () => {
    expect(normalizeTerminalTitle('✦  Typing prompt... (workspace)')).toBe('✦ Gemini CLI')
    expect(normalizeTerminalTitle('⏲  Working… (workspace)')).toBe('✦ Gemini CLI')
  })

  it('collapses Gemini idle and permission titles to stable labels', () => {
    expect(normalizeTerminalTitle('◇  Ready (workspace)')).toBe('◇ Gemini CLI')
    expect(normalizeTerminalTitle('✋  Action Required (workspace)')).toBe('✋ Gemini CLI')
  })

  it('leaves non-Gemini titles unchanged', () => {
    expect(normalizeTerminalTitle('⠂ Claude Code')).toBe('⠂ Claude Code')
    expect(normalizeTerminalTitle('bash')).toBe('bash')
  })

  it('collapses Pi spinner and idle titles to stable labels', () => {
    expect(normalizeTerminalTitle('⠋ π - my-project')).toBe('⠋ Pi')
    expect(normalizeTerminalTitle('π - my-project')).toBe('Pi')
  })
})

describe('isGeminiTerminalTitle', () => {
  it('detects Gemini titles by symbol or name', () => {
    expect(isGeminiTerminalTitle('✦  Typing prompt... (workspace)')).toBe(true)
    expect(isGeminiTerminalTitle('◇  Ready (workspace)')).toBe(true)
    expect(isGeminiTerminalTitle('gemini waiting for input')).toBe(true)
  })

  it('does not match other terminal titles', () => {
    expect(isGeminiTerminalTitle('⠂ Claude Code')).toBe(false)
    expect(isGeminiTerminalTitle('bash')).toBe(false)
  })
})

describe('getAgentLabel', () => {
  it('labels Pi working titles as Pi instead of Claude Code', () => {
    expect(getAgentLabel('⠋ π - my-project')).toBe('Pi')
  })

  it('labels supported agent families consistently', () => {
    expect(getAgentLabel('✦ Gemini CLI')).toBe('Gemini CLI')
    expect(getAgentLabel('⠂ Claude Code')).toBe('Claude Code')
    expect(getAgentLabel('⠋ Codex is thinking')).toBe('Codex')
  })

  it('labels GitHub Copilot CLI', () => {
    expect(getAgentLabel('copilot working')).toBe('GitHub Copilot')
    expect(getAgentLabel('copilot idle')).toBe('GitHub Copilot')
    expect(getAgentLabel('GitHub Copilot CLI')).toBe('GitHub Copilot')
  })
})

describe('createAgentStatusTracker', () => {
  // --- Claude Code: real captured OSC title sequence (v2.1.86) ---
  // CRITICAL: Claude Code changes the title to the TASK DESCRIPTION,
  // not "Claude Code". The ✳ prefix is the only reliable idle indicator.
  it('fires on Claude Code working → idle (real captured titles)', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    // Exact sequence captured from Claude Code v2.1.86 via script(1)
    tracker.handleTitle('✳ Claude Code') // startup idle
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('⠂ Claude Code') // working
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('⠐ Claude Code') // still working
    expect(onBecameIdle).not.toHaveBeenCalled()

    // Claude Code changes title to task description mid-stream!
    tracker.handleTitle('⠐ User acknowledgment and confirmation') // working
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('⠂ User acknowledgment and confirmation') // working
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('✳ User acknowledgment and confirmation') // done → idle
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  // --- Gemini CLI: real title patterns from source code ---
  it('fires on Gemini CLI working → idle (real title patterns)', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('◇  Ready (my-project)') // startup idle
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('✦  Implementing feature (my-project)') // working
    expect(onBecameIdle).not.toHaveBeenCalled()

    tracker.handleTitle('◇  Ready (my-project)') // done → idle
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  it('fires on Gemini CLI working → permission', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('✦  Working… (my-project)') // working
    tracker.handleTitle('✋  Action Required (my-project)') // permission
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  it('fires on Gemini CLI silent working → idle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⏲  Working… (my-project)') // silent working
    tracker.handleTitle('◇  Ready (my-project)') // idle
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  // --- Codex: braille spinner working, bare name idle ---
  it('fires on Codex working → idle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠋ Codex is thinking') // working
    tracker.handleTitle('codex') // idle (bare name)
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  it('fires on Pi working → idle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠋ π - my-project')
    tracker.handleTitle('π - my-project')
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  // --- Multiple cycles ---
  it('fires on each working → idle cycle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    // Cycle 1
    tracker.handleTitle('⠂ Fix login bug')
    tracker.handleTitle('✳ Fix login bug')
    expect(onBecameIdle).toHaveBeenCalledTimes(1)

    // Cycle 2
    tracker.handleTitle('⠐ Refactor auth module')
    tracker.handleTitle('✳ Refactor auth module')
    expect(onBecameIdle).toHaveBeenCalledTimes(2)
  })

  // --- Non-agent titles should not interfere ---
  it('ignores non-agent titles without losing working state', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠂ Claude Code') // working
    tracker.handleTitle('bash') // non-agent (returns null) — should NOT reset
    tracker.handleTitle('✳ Some task description') // idle → should still fire
    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  it('does not fire on idle → idle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('✳ Claude Code') // idle
    tracker.handleTitle('✳ Some other task') // still idle
    expect(onBecameIdle).not.toHaveBeenCalled()
  })

  it('does not fire on working → working', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠂ Claude Code')
    tracker.handleTitle('⠐ Fix the thing')
    tracker.handleTitle('⠂ Fix the thing')
    expect(onBecameIdle).not.toHaveBeenCalled()
  })

  // Why: reset() clears the tracker's working latch so stale working→idle
  // transitions cannot fire after the owning transport is torn down. Without
  // this guarantee, a reattach or late title delivery could surface a
  // phantom idle notification for work the user already dismissed.
  it('reset() clears working state so a subsequent idle does not fire onBecameIdle', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    tracker.handleTitle('⠂ Claude Code') // working
    tracker.reset()
    tracker.handleTitle('✳ Claude Code') // idle — must NOT fire after reset
    expect(onBecameIdle).not.toHaveBeenCalled()
  })

  // --- End-to-end: raw OSC bytes → extractLastOscTitle → tracker ---
  it('end-to-end: extracts OSC title and detects Claude Code transition', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    // Simulate raw PTY data chunks containing OSC title sequences
    // Uses real title patterns: task description, NOT "Claude Code"
    const oscTitle = (title: string): string => `\x1b]0;${title}\x07`

    const chunks = [
      `some output${oscTitle('✳ Claude Code')}more output`,
      `data${oscTitle('⠂ Claude Code')}stuff`,
      `response text${oscTitle('⠐ Fix the login bug')}more`,
      `final output${oscTitle('✳ Fix the login bug')}done`
    ]

    for (const chunk of chunks) {
      const title = extractLastOscTitle(chunk)
      if (title !== null) {
        tracker.handleTitle(title)
      }
    }

    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })

  it('end-to-end: extracts OSC title and detects Gemini transition', () => {
    const onBecameIdle = vi.fn()
    const tracker = createAgentStatusTracker(onBecameIdle)

    const oscTitle = (title: string): string => `\x1b]0;${title}\x07`

    const chunks = [
      oscTitle('◇  Ready (workspace)'),
      oscTitle('✦  Analyzing code (workspace)'),
      oscTitle('◇  Ready (workspace)')
    ]

    for (const chunk of chunks) {
      const title = extractLastOscTitle(chunk)
      if (title !== null) {
        tracker.handleTitle(title)
      }
    }

    expect(onBecameIdle).toHaveBeenCalledTimes(1)
  })
})

describe('isExplicitAgentStatusFresh', () => {
  it('treats the boundary (now - updatedAt == staleAfterMs) as fresh', () => {
    // Why: the function uses `<=`, so equality at the boundary must remain
    // fresh. Protecting this invariant keeps entries from flipping to stale
    // one tick earlier than the configured TTL implies.
    const staleAfterMs = 60_000
    const now = 1_000_000
    const entry = { updatedAt: now - staleAfterMs }
    expect(isExplicitAgentStatusFresh(entry, now, staleAfterMs)).toBe(true)
  })

  it('treats one millisecond past the boundary as stale', () => {
    const staleAfterMs = 60_000
    const now = 1_000_000
    const entry = { updatedAt: now - staleAfterMs - 1 }
    expect(isExplicitAgentStatusFresh(entry, now, staleAfterMs)).toBe(false)
  })

  it('treats a just-updated entry (now - updatedAt == 0) as fresh', () => {
    const staleAfterMs = 60_000
    const now = 1_000_000
    const entry = { updatedAt: now }
    expect(isExplicitAgentStatusFresh(entry, now, staleAfterMs)).toBe(true)
  })
})

describe('mapAgentStatusStateToVisualStatus', () => {
  it("maps 'working' to 'working'", () => {
    expect(mapAgentStatusStateToVisualStatus('working')).toBe('working')
  })

  it("maps 'blocked' to 'permission'", () => {
    expect(mapAgentStatusStateToVisualStatus('blocked')).toBe('permission')
  })

  it("maps 'waiting' to 'permission'", () => {
    expect(mapAgentStatusStateToVisualStatus('waiting')).toBe('permission')
  })

  it("maps 'done' to 'active'", () => {
    expect(mapAgentStatusStateToVisualStatus('done')).toBe('active')
  })

  it('returns a non-empty string for every valid state', () => {
    for (const state of ['working', 'blocked', 'waiting', 'done'] as const) {
      const visual = mapAgentStatusStateToVisualStatus(state)
      expect(typeof visual).toBe('string')
      expect(visual.length).toBeGreaterThan(0)
    }
  })
})

describe('formatAgentTypeLabel', () => {
  it("returns 'Agent' for null", () => {
    expect(formatAgentTypeLabel(null)).toBe('Agent')
  })

  it("returns 'Agent' for undefined", () => {
    expect(formatAgentTypeLabel(undefined)).toBe('Agent')
  })

  it("returns 'Agent' for 'unknown'", () => {
    expect(formatAgentTypeLabel('unknown')).toBe('Agent')
  })

  it("maps 'claude' to 'Claude'", () => {
    expect(formatAgentTypeLabel('claude')).toBe('Claude')
  })

  it("maps 'codex' to 'Codex'", () => {
    expect(formatAgentTypeLabel('codex')).toBe('Codex')
  })

  it("maps 'gemini' to 'Gemini'", () => {
    expect(formatAgentTypeLabel('gemini')).toBe('Gemini')
  })

  it("passes through unknown-but-nonsentinel strings as-is (e.g. 'cursor')", () => {
    expect(formatAgentTypeLabel('cursor')).toBe('cursor')
  })
})

describe('agentTypeToIconAgent', () => {
  it('returns null for null', () => {
    expect(agentTypeToIconAgent(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(agentTypeToIconAgent(undefined)).toBeNull()
  })

  it("returns null for 'unknown'", () => {
    expect(agentTypeToIconAgent('unknown')).toBeNull()
  })

  it("round-trips iconable agent types like 'claude'", () => {
    expect(agentTypeToIconAgent('claude')).toBe('claude')
  })

  it('returns null for arbitrary non-iconable strings', () => {
    // Why: guards against hook payloads reporting agentTypes that AgentIcon
    // cannot render (e.g. "totally-fake-agent"); returning null lets the
    // caller fall back to a neutral glyph instead of a broken icon.
    expect(agentTypeToIconAgent('totally-fake-agent')).toBeNull()
  })
})
