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

// Source: .tmp/ime-handoff/evidence/windows-12179-real-tui/landing-clean-v4/clean-haetda-pre-submit-summary.json
// SHA-256: 949a293c586f5326821a3f85711d2bf1dda81077cc39b924f75baf0b96e08c32
const SHIFTED_BATCHIM_KEYDOWNS = [
  event({
    key: 'Process',
    code: 'ShiftLeft',
    keyCode: 229,
    shiftKey: true,
    isComposing: true
  }),
  event({
    key: 'Shift',
    code: 'ShiftLeft',
    keyCode: 16,
    shiftKey: true,
    isComposing: true
  }),
  event({ key: 'Process', keyCode: 229, shiftKey: true, isComposing: true })
]

// Source: .tmp/ime-handoff/evidence/windows-12179-real-tui/landing-clean-v4/clean-english-haetda-pre-submit-summary.json
// SHA-256: 7fd76358ff26f79d6d833e7350362651f1ca62a419c733702ebce03498b74f4e
const ORDINARY_SHIFTED_T_KEYDOWNS = [
  event({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true }),
  event({ key: 'T', keyCode: 84, shiftKey: true })
]

describe('Windows shifted batchim terminal input', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model v1.4.163's code-blind composition classifier behind the ownership guard.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.isComposing && keyboardEvent.shiftKey
        ? { type: 'sendInput', data: '\x1b\r' }
        : null
    )
  })

  it('does not turn the recorded ㅆ keydowns in 했다 into a newline', () => {
    const terminalInput = replayKeyDowns(SHIFTED_BATCHIM_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b\r')
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
  })

  it('lets the same shifted key outside composition follow ordinary input', () => {
    const terminalInput = replayKeyDowns(ORDINARY_SHIFTED_T_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b\r')
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(2)
    expect(shortcutPolicy.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'T', keyCode: 84, shiftKey: true, isComposing: false }),
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
