import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalShortcutPolicyModule from './terminal-shortcut-policy'
import { resolveTerminalKeyboardShortcutAction } from './keyboard-handlers'

const shortcutPolicy = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('./terminal-shortcut-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalShortcutPolicyModule>()),
  resolveTerminalShortcutAction: shortcutPolicy.resolve
}))

// `location` is carried because the release loses it under MS Korean and keeps it under en-US.
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

const POLICY_TAIL = [
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
] as const

// Source: .tmp/ime-handoff/evidence/windows-ko-fidelity-20260805/
// file `records-ko.json`, SHA-256 d77b92e7e9a1c92a5a97eeccb44c21f734c249f367b8dda79ba51fe1abc51525
// MS Korean (0412) driven by `SendInput` with layout-resolved scan codes, so `code` and `location`
// are populated. Records 38-59: one ShiftLeft press held across a jamo commit, then RELEASED at
// record 51, then a fresh composition. Only keydowns appear below — this owner is installed on
// `keydown` alone (`keyboard-handlers.ts` window listener), so the release itself never reaches it.
const SHIFT_HELD_KEYDOWNS = [
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

// Records 52 and 59 of the same capture: the first two keydowns AFTER the Shift release at 51.
// This row reports the release itself emitting an Enter, so what follows it is the observable.
const KEYDOWNS_AFTER_SHIFT_RELEASE = [
  event({ key: 'Process', code: 'KeyR', keyCode: 229 }),
  event({ key: 'Process', code: 'KeyK', keyCode: 229, isComposing: true })
]

// Records 49-51 of the same capture, retained as a fixture guard rather than as input: the
// release is three keyups, and `shiftKey` is already false on the ShiftLeft keyup that ends it.
const RECORDED_RELEASE_KEYUPS = [
  { type: 'keyup', key: 'Process', code: 'Enter', keyCode: 229, shiftKey: true },
  { type: 'keyup', key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true },
  { type: 'keyup', key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1, shiftKey: false }
] as const

// Source: same bundle, file `records-en.json`
// SHA-256: a6c9f630fb850c18b5e608ed425ae4dfa323355ec2928a056dd360c8d40a4c92
// Same host, same injector, en-US and no IME: `a`, ShiftLeft+A, ShiftRight+A, Enter, ArrowLeft.
// Every keydown of the session. Both Shift gestures are pressed AND released here, and the Enter
// at record 19 is typed after both releases — the ordinary counterpart of this row's gesture.
const ORDINARY_SESSION_KEYDOWNS = [
  event({ key: 'a', code: 'KeyA', keyCode: 65 }),
  event({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, location: 1, shiftKey: true }),
  event({ key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true }),
  event({ key: 'Shift', code: 'ShiftRight', keyCode: 16, location: 2, shiftKey: true }),
  event({ key: 'A', code: 'KeyA', keyCode: 65, shiftKey: true }),
  event({ key: 'Enter', code: 'Enter', keyCode: 13 }),
  event({ key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 })
]

const WINDOWS_SHIFT_ENTER_NEWLINE = '\x1b\r'

describe('STA-3179 Windows Korean Shift release must not synthesize Enter', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model v1.4.163's composition classifier behind the ownership guard, plus the ordinary
    // Shift+Enter the user really pressed — both encode as ESC CR, so the guard is what separates
    // them.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.shiftKey && (keyboardEvent.isComposing || keyboardEvent.key === 'Enter')
        ? { type: 'sendInput', data: WINDOWS_SHIFT_ENTER_NEWLINE }
        : null
    )
  })

  it('gives the held-Shift gesture one newline, from the unmarked Enter alone', () => {
    const terminalInput = replayKeyDowns(SHIFT_HELD_KEYDOWNS)

    expect(terminalInput).toEqual([WINDOWS_SHIFT_ENTER_NEWLINE])
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(1)
    expect(shortcutPolicy.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'Enter', keyCode: 13, shiftKey: true, isComposing: false }),
      ...POLICY_TAIL
    )
  })

  it('leaves nothing armed by the release for the next composition to trip', () => {
    // Precondition: the release is keyups, and the last of them has already dropped shiftKey.
    expect(RECORDED_RELEASE_KEYUPS.every(({ type }) => type === 'keyup')).toBe(true)
    expect(RECORDED_RELEASE_KEYUPS.at(-1)).toMatchObject({ keyCode: 16, shiftKey: false })

    const terminalInput = replayKeyDowns(KEYDOWNS_AFTER_SHIFT_RELEASE)

    expect(terminalInput).toEqual([])
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
  })

  it('still routes every keydown of the ordinary Shift press-and-release session', () => {
    const terminalInput = replayKeyDowns(ORDINARY_SESSION_KEYDOWNS)

    expect(terminalInput).toEqual([])
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(ORDINARY_SESSION_KEYDOWNS.length)
    // The bare ShiftRight press: same key the Korean arm marks, with no IME running.
    expect(shortcutPolicy.resolve).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        key: 'Shift',
        code: 'ShiftRight',
        keyCode: 16,
        location: 2,
        shiftKey: true,
        isComposing: false
      }),
      ...POLICY_TAIL
    )
    // The Enter typed after both releases carries no Shift, so it is a plain Enter.
    expect(shortcutPolicy.resolve).toHaveBeenNthCalledWith(
      6,
      expect.objectContaining({ key: 'Enter', keyCode: 13, shiftKey: false }),
      ...POLICY_TAIL
    )
  })
})
