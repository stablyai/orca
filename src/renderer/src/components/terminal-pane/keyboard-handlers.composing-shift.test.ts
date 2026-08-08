import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalShortcutPolicyModule from './terminal-shortcut-policy'
import { resolveTerminalKeyboardShortcutAction } from './keyboard-handlers'

const shortcutPolicy = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('./terminal-shortcut-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalShortcutPolicyModule>()),
  resolveTerminalShortcutAction: shortcutPolicy.resolve
}))

type RecordedKeyboardEvent = TerminalShortcutPolicyModule.TerminalShortcutEvent & {
  isComposing: boolean
  keyCode: number
}

function event(overrides: Partial<RecordedKeyboardEvent>): RecordedKeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    ...overrides
  }
}

function replayKeyDowns(events: RecordedKeyboardEvent[]): ReturnType<typeof vi.fn> {
  const terminalInput = vi.fn()

  for (const keyboardEvent of events) {
    const action = resolveTerminalKeyboardShortcutAction(
      keyboardEvent,
      false,
      'false',
      0,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      () => 'alt-enter',
      () => true
    )
    if (action?.type === 'sendInput') {
      terminalInput(action.data)
    }
  }

  return terminalInput
}

// Source: .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/MUT-shift-left.json
// SHA-256: 7b27e3bbdd69c554e6e3ab359c96e1d7a3dd89444db95ac62b272b8892e6d70c
const COMPOSING_SHIFT_KEYDOWNS = [
  event({
    key: 'Process',
    code: 'ShiftLeft',
    keyCode: 229,
    shiftKey: true,
    isComposing: true
  })
]

// Source: .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/NL-shift-nocomp.json
// SHA-256: c9ae9a5e3e1acb52f57ea9d6e4f305a2efd15e5cab31fbe7e69ac2067816bb85
const ORDINARY_SHIFT_KEYDOWNS = [
  event({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true })
]

describe('Windows Shift during terminal composition', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model v1.4.163's code-blind composition classifier behind the ownership guard.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.isComposing && keyboardEvent.shiftKey
        ? { type: 'sendInput', data: '\x1b\r' }
        : null
    )
  })

  it('does not turn the recorded composing Shift press into a newline', () => {
    const terminalInput = replayKeyDowns(COMPOSING_SHIFT_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b\r')
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
  })

  it('lets the ordinary Shift press follow shortcut policy', () => {
    const terminalInput = replayKeyDowns(ORDINARY_SHIFT_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b\r')
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(1)
    expect(shortcutPolicy.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'Shift',
        code: 'ShiftLeft',
        keyCode: 16,
        shiftKey: true,
        isComposing: false
      }),
      false,
      'false',
      0,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
      expect.any(Function),
      'orca-first'
    )
  })
})
