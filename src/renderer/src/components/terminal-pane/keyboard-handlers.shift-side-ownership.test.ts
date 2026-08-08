import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalShortcutPolicyModule from './terminal-shortcut-policy'
import { resolveTerminalKeyboardShortcutAction } from './keyboard-handlers'

const shortcutPolicy = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('./terminal-shortcut-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalShortcutPolicyModule>()),
  resolveTerminalShortcutAction: shortcutPolicy.resolve
}))

// `location` is carried because this row turns on ShiftLeft (1) vs ShiftRight (2).
type RecordedKeyboardEvent = TerminalShortcutPolicyModule.TerminalShortcutEvent & {
  isComposing: boolean
  keyCode: number
  location: number
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
    location: 0,
    ...overrides
  }
}

function replayKeyDowns(events: RecordedKeyboardEvent[]): string[] {
  const terminalInput: string[] = []

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
      terminalInput.push(action.data)
    }
  }

  return terminalInput
}

// Source: .tmp/ime-handoff/evidence/windows-ko-fidelity-20260805/records-ko.json
// SHA-256: d77b92e7e9a1c92a5a97eeccb44c21f734c249f367b8dda79ba51fe1abc51525
// Faithful MS Korean (0412) SendInput trace with real scan codes, so `code`/`location` are
// populated. Records 38-45 are the ShiftLeft arm of one `가` + Shift+Enter.
const SHIFT_LEFT_ARM_KEYDOWNS = [
  event({
    key: 'Process',
    code: 'ShiftLeft',
    keyCode: 229,
    location: 1,
    shiftKey: true,
    isComposing: true
  }),
  event({
    key: 'Shift',
    code: 'ShiftLeft',
    keyCode: 16,
    location: 1,
    shiftKey: true,
    isComposing: true
  }),
  event({ key: 'Process', code: 'Enter', keyCode: 229, shiftKey: true, isComposing: true }),
  event({ key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true })
]

// Same artifact, records 65-72: the ShiftRight arm of the identical gesture. The IME-marked
// keydown carries `ShiftRight`/location 2; the unmarked Shift that follows loses both fields
// under this IME, which is why ownership must not be decided from `code` or `location`.
const SHIFT_RIGHT_ARM_KEYDOWNS = [
  event({
    key: 'Process',
    code: 'ShiftRight',
    keyCode: 229,
    location: 2,
    shiftKey: true,
    isComposing: true
  }),
  event({ key: 'Shift', code: '', keyCode: 16, shiftKey: true, isComposing: true }),
  event({ key: 'Process', code: 'Enter', keyCode: 229, shiftKey: true, isComposing: true }),
  event({ key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true })
]

// Source: .tmp/ime-handoff/evidence/windows-ko-fidelity-20260805/records-en.json
// SHA-256: a6c9f630fb850c18b5e608ed425ae4dfa323355ec2928a056dd360c8d40a4c92
// Same host, same 0xA1/scan 0x36 injection, en-US and no IME: records 12-13, where
// ShiftRight keeps `ShiftRight`/location 2 and nothing is composing.
const ORDINARY_SHIFT_RIGHT_KEYDOWNS = [
  event({ key: 'Shift', code: 'ShiftRight', keyCode: 16, location: 2, shiftKey: true }),
  event({ key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true })
]

describe('Windows Shift side ownership during terminal composition', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model v1.4.163's code-blind composition classifier behind the ownership guard, plus the
    // ordinary Shift+Enter the user actually pressed — both encode as ESC CR.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.shiftKey && (keyboardEvent.isComposing || keyboardEvent.key === 'Enter')
        ? { type: 'sendInput', data: '\x1b\r' }
        : null
    )
  })

  it('gives both recorded Shift sides one newline, from the unmarked Enter alone', () => {
    // Guard the fixtures: the two arms must stay distinguishable, or the row is not tested.
    expect(SHIFT_LEFT_ARM_KEYDOWNS[0]).toMatchObject({ code: 'ShiftLeft', location: 1 })
    expect(SHIFT_RIGHT_ARM_KEYDOWNS[0]).toMatchObject({ code: 'ShiftRight', location: 2 })

    for (const arm of [SHIFT_LEFT_ARM_KEYDOWNS, SHIFT_RIGHT_ARM_KEYDOWNS]) {
      shortcutPolicy.resolve.mockClear()
      const terminalInput = replayKeyDowns(arm)

      expect(terminalInput).toEqual(['\x1b\r'])
      expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(1)
      expect(shortcutPolicy.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'Enter', keyCode: 13, shiftKey: true, isComposing: false }),
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
    }
  })

  it('lets the ordinary ShiftRight press follow shortcut policy', () => {
    const terminalInput = replayKeyDowns(ORDINARY_SHIFT_RIGHT_KEYDOWNS)

    expect(terminalInput).toEqual([])
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(2)
    expect(shortcutPolicy.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'Shift',
        code: 'ShiftRight',
        keyCode: 16,
        location: 2,
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
