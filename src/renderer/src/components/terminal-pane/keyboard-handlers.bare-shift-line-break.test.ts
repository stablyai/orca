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

// Sources: .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/NL-shift-left.json
// SHA-256: 8b72ba833241003e16d1b36485fe5c419ce05b36d2e3777093d45f198d82e3f3
// .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/NL-shift-right.json
// SHA-256: ffc29856dddf12afb9ca92c9e6c77c246a9dbc50f036c019cb531bcc1d6cd1a7
const COMPOSING_BARE_SHIFT_KEYDOWNS = [
  event({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true, isComposing: true }),
  event({ key: 'Shift', code: '', keyCode: 16, shiftKey: true, isComposing: true })
]

// Source: .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/NL-shift-nocomp.json
// SHA-256: c9ae9a5e3e1acb52f57ea9d6e4f305a2efd15e5cab31fbe7e69ac2067816bb85
const ORDINARY_BARE_SHIFT_KEYDOWNS = [
  event({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true })
]

describe('Windows bare Shift during terminal composition', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model v1.4.163's code-blind composition classifier behind the ownership guard.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.isComposing && keyboardEvent.shiftKey
        ? { type: 'sendInput', data: '\x1b\r' }
        : null
    )
  })

  it('does not turn either recorded bare Shift press into ESC CR', () => {
    const terminalInput = replayKeyDowns(COMPOSING_BARE_SHIFT_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b\r')
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
  })

  it('lets an ordinary bare Shift press follow shortcut policy exactly once', () => {
    const terminalInput = replayKeyDowns(ORDINARY_BARE_SHIFT_KEYDOWNS)

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
