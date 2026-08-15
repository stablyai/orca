import { describe, expect, it, vi } from 'vitest'
import {
  cycleClaudePermissionMode,
  describeClaudePermissionModeCycle
} from './claude-permission-mode-cycle'
import { readClaudePermissionModeFromTerminalScreen } from './claude-terminal-session-options'

const KEY = '\x1b[Z'

/** Drives readMode through a fixed sequence, then repeats the last entry —
 * enough to prove the cycler's own bounds stop it, not a finite fake. */
function sequentialReader(modes: readonly string[]): () => Promise<string | null> {
  let index = 0
  return async () => {
    const mode = modes[Math.min(index, modes.length - 1)]
    index += 1
    return mode
  }
}

/** Loops through a fixed set of modes forever, simulating Shift+Tab cycling
 * within a real session (used for the "not in this cycle" scenario). */
function loopingReader(modes: readonly string[]): () => Promise<string | null> {
  let index = 0
  return async () => {
    const mode = modes[index % modes.length]
    index += 1
    return mode
  }
}

describe('cycleClaudePermissionMode', () => {
  it('reaches the target in one press', async () => {
    const sendKey = vi.fn(() => true)
    const outcome = await cycleClaudePermissionMode({
      target: 'acceptEdits',
      readMode: sequentialReader(['manual', 'acceptEdits']),
      sendKey,
      key: KEY,
      settleMs: 0
    })
    expect(outcome.outcome).toBe('applied')
    expect(sendKey).toHaveBeenCalledTimes(1)
    expect(sendKey).toHaveBeenCalledWith(KEY)
  })

  it('reaches a target several presses away, pressing exactly that many times', async () => {
    const sendKey = vi.fn(() => true)
    const outcome = await cycleClaudePermissionMode({
      target: 'bypassPermissions',
      readMode: sequentialReader(['manual', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']),
      sendKey,
      key: KEY,
      settleMs: 0
    })
    expect(outcome.outcome).toBe('applied')
    expect(sendKey).toHaveBeenCalledTimes(4)
  })

  it('is already on the target: applied with zero presses', async () => {
    const sendKey = vi.fn(() => true)
    const outcome = await cycleClaudePermissionMode({
      target: 'plan',
      readMode: sequentialReader(['plan']),
      sendKey,
      key: KEY,
      settleMs: 0
    })
    expect(outcome.outcome).toBe('applied')
    expect(sendKey).not.toHaveBeenCalled()
  })

  it('reports unavailable and stops after one lap when the target is not in the cycle', async () => {
    const sendKey = vi.fn(() => true)
    const outcome = await cycleClaudePermissionMode({
      target: 'bypassPermissions',
      readMode: loopingReader(['manual', 'acceptEdits', 'plan']),
      sendKey,
      key: KEY,
      settleMs: 0
    })
    expect(outcome.outcome).toBe('unavailable')
    // A 3-mode cycle repeats after 3 presses — far short of pressing forever
    // or exhausting the (higher) maxPresses safety bound.
    expect(sendKey).toHaveBeenCalledTimes(3)
  })

  it('returns unknown without pressing when the mode is unreadable from the start', async () => {
    const sendKey = vi.fn(() => true)
    const outcome = await cycleClaudePermissionMode({
      target: 'plan',
      readMode: async () => null,
      sendKey,
      key: KEY,
      settleMs: 0
    })
    expect(outcome.outcome).toBe('unknown')
    expect(sendKey).not.toHaveBeenCalled()
  })

  it('returns unknown when the key press cannot be delivered', async () => {
    const outcome = await cycleClaudePermissionMode({
      target: 'plan',
      readMode: sequentialReader(['manual', 'acceptEdits']),
      sendKey: () => false,
      key: KEY,
      settleMs: 0
    })
    expect(outcome.outcome).toBe('unknown')
  })

  it('honours isCancelled and never presses once cancelled', async () => {
    const sendKey = vi.fn(() => true)
    const outcome = await cycleClaudePermissionMode({
      target: 'plan',
      readMode: sequentialReader(['manual', 'manual', 'manual']),
      sendKey,
      key: KEY,
      settleMs: 0,
      isCancelled: () => true
    })
    expect(outcome.outcome).toBe('unknown')
    expect(sendKey).not.toHaveBeenCalled()
  })

  it('stops at the maxPresses bound instead of looping forever', async () => {
    const sendKey = vi.fn(() => true)
    let index = 0
    // A pathological reader that never repeats and never matches the target —
    // only the press-count bound can terminate this one.
    const outcome = await cycleClaudePermissionMode({
      target: 'never-shown',
      readMode: async () => `mode-${index++}`,
      sendKey,
      key: KEY,
      settleMs: 0,
      maxPresses: 6
    })
    expect(outcome.outcome).toBe('unknown')
    expect(sendKey).toHaveBeenCalledTimes(6)
  })

  describe('end-to-end with the real status-line reader', () => {
    function readModeFromStatusLine(statusLine: string): () => Promise<string | null> {
      // Reads the status line directly — the banner scrolls away, so the
      // model-gated scrape cannot be the cycler's source of truth.
      return async () => readClaudePermissionModeFromTerminalScreen(`> \n${statusLine}`)
    }

    it("recognizes plan mode from Claude's real status line and stops immediately", async () => {
      const sendKey = vi.fn(() => true)
      const outcome = await cycleClaudePermissionMode({
        target: 'plan',
        readMode: readModeFromStatusLine('▶▶ plan mode on (shift+tab to cycle)'),
        sendKey,
        key: KEY,
        settleMs: 0
      })
      expect(outcome.outcome).toBe('applied')
      expect(sendKey).not.toHaveBeenCalled()
    })

    it("recognizes bypass permissions from Claude's real status line", async () => {
      const sendKey = vi.fn(() => true)
      const outcome = await cycleClaudePermissionMode({
        target: 'bypassPermissions',
        readMode: readModeFromStatusLine('▶▶ bypass permissions on (shift+tab to cycle)'),
        sendKey,
        key: KEY,
        settleMs: 0
      })
      expect(outcome.outcome).toBe('applied')
      expect(sendKey).not.toHaveBeenCalled()
    })
  })
})

describe('describeClaudePermissionModeCycle', () => {
  // Why: every failure here is invisible from the chat pane — the toast is the
  // only place the user learns which step gave up.
  it('names the step that gave up, with the modes it saw', async () => {
    const stuck = await cycleClaudePermissionMode({
      target: 'plan',
      readMode: async () => 'auto',
      sendKey: () => true,
      key: '\x1b[Z'
    })
    expect(describeClaudePermissionModeCycle('plan', stuck)).toBe(
      "plan is not in this session's cycle; saw auto → auto."
    )
  })

  it('reports an unreadable terminal distinctly from a stuck cycle', async () => {
    const blind = await cycleClaudePermissionMode({
      target: 'plan',
      readMode: async () => null,
      sendKey: () => true,
      key: '\x1b[Z'
    })
    expect(blind.presses).toBe(0)
    expect(describeClaudePermissionModeCycle('plan', blind)).toMatch(/could not read/i)
  })

  it('reports an undelivered keystroke', async () => {
    const undelivered = await cycleClaudePermissionMode({
      target: 'plan',
      readMode: async () => 'auto',
      sendKey: () => false,
      key: '\x1b[Z'
    })
    expect(describeClaudePermissionModeCycle('plan', undelivered)).toMatch(/did not accept/i)
  })
})
