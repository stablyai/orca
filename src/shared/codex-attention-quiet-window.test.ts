import { describe, expect, it } from 'vitest'
import {
  CODEX_ATTENTION_QUIET_MS,
  SYNTHETIC_PERMISSION_BELL,
  buildSyntheticTerminalTitleFrame,
  shouldDeferSyntheticPermissionBell
} from './codex-attention-quiet-window'
import { createTerminalTitleTracker } from './terminal-output-side-effects'
import { getSyntheticAgentTitleProfile } from './synthetic-agent-title'

const CODEX_PERMISSION_LABEL = getSyntheticAgentTitleProfile('codex')?.permissionLabel ?? ''
const CODEX_IDLE_LABEL = getSyntheticAgentTitleProfile('codex')?.idleLabel ?? ''

/** Count the bells a fabricated frame would ring through the real per-PTY tracker. */
function bellsFromSyntheticFrames(frames: readonly string[]): number {
  let bells = 0
  const tracker = createTerminalTitleTracker({ onBell: () => (bells += 1) })
  try {
    for (const frame of frames) {
      tracker.applySyntheticTitleFrame(frame)
    }
  } finally {
    tracker.dispose()
  }
  return bells
}

describe('shouldDeferSyntheticPermissionBell', () => {
  it('defers only Codex permission pauses', () => {
    expect(shouldDeferSyntheticPermissionBell({ agentType: 'codex', state: 'waiting' })).toBe(true)
    expect(shouldDeferSyntheticPermissionBell({ agentType: 'codex', state: 'blocked' })).toBe(true)
    expect(shouldDeferSyntheticPermissionBell({ agentType: 'codex', state: 'done' })).toBe(false)
    expect(shouldDeferSyntheticPermissionBell({ agentType: 'codex', state: 'working' })).toBe(false)
  })

  it('leaves every other runtime ringing immediately', () => {
    for (const agentType of ['claude', 'cursor', 'opencode', 'pi', null, undefined]) {
      expect(shouldDeferSyntheticPermissionBell({ agentType, state: 'waiting' })).toBe(false)
    }
  })

  it('never defers a question put to the user — no auto-reviewer answers those', () => {
    for (const toolName of ['request_user_input', 'AskUserQuestion', 'requestUserInput']) {
      expect(
        shouldDeferSyntheticPermissionBell({ agentType: 'codex', state: 'waiting', toolName })
      ).toBe(false)
    }
  })

  it('still defers an ordinary Codex approval pause carrying a tool name', () => {
    expect(
      shouldDeferSyntheticPermissionBell({
        agentType: 'codex',
        state: 'waiting',
        toolName: 'exec_command'
      })
    ).toBe(true)
  })
})

describe('buildSyntheticTerminalTitleFrame', () => {
  it('holds the attention BEL out of a Codex permission frame while keeping the title', () => {
    const { frame, deferBell } = buildSyntheticTerminalTitleFrame({
      agentType: 'codex',
      state: 'waiting',
      label: CODEX_PERMISSION_LABEL
    })

    expect(deferBell).toBe(true)
    expect(frame).toBe(`\x1b]0;${CODEX_PERMISSION_LABEL}\x07`)
    // The lone \x07 left in the frame is the OSC terminator, not a bell.
    expect(bellsFromSyntheticFrames([frame])).toBe(0)
  })

  it('still rings a non-Codex permission frame inline', () => {
    const claudePermissionLabel = 'Claude - action required'
    const { frame, deferBell } = buildSyntheticTerminalTitleFrame({
      agentType: 'claude',
      state: 'blocked',
      label: claudePermissionLabel
    })

    expect(deferBell).toBe(false)
    expect(frame).toBe(`\x1b]0;${claudePermissionLabel}\x07\x07`)
    expect(bellsFromSyntheticFrames([frame])).toBe(1)
  })

  it('rings a Codex request_user_input pause inline, without the quiet window', () => {
    const { frame, deferBell } = buildSyntheticTerminalTitleFrame({
      agentType: 'codex',
      state: 'waiting',
      toolName: 'request_user_input',
      label: CODEX_PERMISSION_LABEL
    })

    expect(deferBell).toBe(false)
    expect(bellsFromSyntheticFrames([frame])).toBe(1)
  })

  it('never rings a terminal idle frame', () => {
    const { frame, deferBell } = buildSyntheticTerminalTitleFrame({
      agentType: 'codex',
      state: 'done',
      label: CODEX_IDLE_LABEL
    })

    expect(deferBell).toBe(false)
    expect(frame).toBe(`\x1b]0;${CODEX_IDLE_LABEL}\x07`)
    expect(bellsFromSyntheticFrames([frame])).toBe(0)
  })

  it('rings once when the deferred BEL is released for a real pause', () => {
    // Guards the over-suppression failure mode: a Codex pause the user must answer still
    // reaches onBell — just after the quiet window instead of inside it.
    const { frame } = buildSyntheticTerminalTitleFrame({
      agentType: 'codex',
      state: 'waiting',
      label: CODEX_PERMISSION_LABEL
    })

    expect(bellsFromSyntheticFrames([frame, SYNTHETIC_PERMISSION_BELL])).toBe(1)
  })

  it('pins the pre-fix frame as the one that rang inline (#13600 regression anchor)', () => {
    // The shipped 1.4.179 frame; asserting it still rings proves the new frame's silence is
    // the fix, not a tracker that stopped seeing fabricated bells.
    expect(bellsFromSyntheticFrames([`\x1b]0;${CODEX_PERMISSION_LABEL}\x07\x07`])).toBe(1)
  })
})

describe('CODEX_ATTENTION_QUIET_MS', () => {
  it('is the single window both attention paths wait out', () => {
    expect(CODEX_ATTENTION_QUIET_MS).toBe(1_500)
  })
})
