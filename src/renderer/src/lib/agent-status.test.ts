import { describe, expect, it, vi } from 'vitest'
import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker
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

  // --- Case insensitivity ---
  it('is case-insensitive for agent names', () => {
    expect(detectAgentStatusFromTitle('CLAUDE')).toBe('idle')
    expect(detectAgentStatusFromTitle('Codex Working')).toBe('working')
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
