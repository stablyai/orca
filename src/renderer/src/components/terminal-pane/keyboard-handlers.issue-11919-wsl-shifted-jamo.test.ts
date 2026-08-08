import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TerminalShortcutPolicyModule from './terminal-shortcut-policy'
import { resolveTerminalKeyboardShortcutAction } from './keyboard-handlers'

const shortcutPolicy = vi.hoisted(() => ({ resolve: vi.fn() }))

vi.mock('./terminal-shortcut-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalShortcutPolicyModule>()),
  resolveTerminalShortcutAction: shortcutPolicy.resolve
}))

const { resolveTerminalShortcutAction: actualResolveTerminalShortcutAction } =
  await vi.importActual<typeof TerminalShortcutPolicyModule>('./terminal-shortcut-policy')

type RecordedKeyboardEvent = TerminalShortcutPolicyModule.TerminalShortcutEvent & {
  isComposing: boolean
  keyCode: number
}

const POLICY_ARGS = [
  false,
  'false',
  0,
  true,
  undefined,
  undefined,
  undefined,
  undefined,
  () => 'alt-enter' as const,
  () => true
] as const

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
    const action = resolveTerminalKeyboardShortcutAction(keyboardEvent, ...POLICY_ARGS)
    if (action?.type === 'sendInput') {
      terminalInput(action.data)
    }
  }

  return terminalInput
}

// Source: .tmp/ime-handoff/evidence/11919-windows-wsl-current/11919-current-owner.json
// SHA-256: eafef03dafcd8396665476896a9ac27d07052b7025ad6ac417849906492c026a
// Windows 11 + MS Korean IME (2-set) driving a WSL-bound Orca terminal; every `immediate`-phase
// keydown of the four injected cases, in order. `code` is empty on every one of them, which is why
// v1.4.164's later `code` guard could not have closed this row either.
const RECORDED_SESSION_KEYDOWNS = [
  // 문제 (mun-je)
  event({ key: 'Process', keyCode: 229 }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Enter', keyCode: 13 }),
  // 모르겠네 — 겠 needs ㅆ, which 2-set Korean types as Shift+T
  event({ key: 'Process', keyCode: 229 }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, shiftKey: true, isComposing: true }),
  event({ key: 'Shift', keyCode: 16, shiftKey: true, isComposing: true }),
  event({ key: 'Process', keyCode: 229, shiftKey: true, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Enter', keyCode: 13 }),
  // 안녕하세요
  event({ key: 'Process', keyCode: 229 }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Process', keyCode: 229, isComposing: true }),
  event({ key: 'Enter', keyCode: 13 }),
  // hello — same session, IME off
  event({ key: 'h', keyCode: 72 }),
  event({ key: 'e', keyCode: 69 }),
  event({ key: 'l', keyCode: 76 }),
  event({ key: 'l', keyCode: 76 }),
  event({ key: 'o', keyCode: 79 }),
  event({ key: 'Enter', keyCode: 13 })
]

// The only Shift-carrying keydowns in the whole session, all inside 겠.
const RECORDED_SHIFTED_JAMO_KEYDOWNS = RECORDED_SESSION_KEYDOWNS.filter(({ shiftKey }) => shiftKey)

// The same session's keydowns that no IME ever claimed: hello's five letters and four Enters.
const RECORDED_ORDINARY_KEYDOWNS = RECORDED_SESSION_KEYDOWNS.filter(
  ({ keyCode, isComposing }) => keyCode !== 229 && !isComposing
)

// Same capture, `result.onData[].hex`: the bytes the renderer actually handed the WSL PTY.
const RECORDED_ONDATA_HEX = [
  'ebacb8',
  'eca09c',
  '0d',
  'ebaaa8',
  'eba5b4',
  'eab2a0',
  'eb84a4',
  '0d',
  'ec9588',
  'eb8595',
  'ed9598',
  'ec84b8',
  'ec9a94',
  '0d',
  '68',
  '65',
  '6c',
  '6c',
  '6f',
  '0d'
]
const CARRIAGE_RETURN_HEX = '0d'
const WINDOWS_SHIFT_ENTER_NEWLINE = '\x1b\r'

describe('#11919 Windows/WSL Korean syllables split by newlines', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // v1.4.163 classified `Process`/229 carrying a lone Shift as Enter and rewrote the event to
    // Shift+Enter, so anything that still reaches the policy mid-composition splits the word.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.key === 'Process' && keyboardEvent.keyCode === 229 && keyboardEvent.shiftKey
        ? { type: 'sendInput', data: WINDOWS_SHIFT_ENTER_NEWLINE }
        : null
    )
  })

  it('keeps the recorded shifted-jamo keydowns of 겠 away from shortcut policy', () => {
    const terminalInput = replayKeyDowns(RECORDED_SHIFTED_JAMO_KEYDOWNS)

    expect(RECORDED_SHIFTED_JAMO_KEYDOWNS).toHaveLength(3)
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
    expect(terminalInput.mock.calls).toEqual([])
  })

  it('adds no newline of its own across the whole recorded session', () => {
    const terminalInput = replayKeyDowns(RECORDED_SESSION_KEYDOWNS)
    const enterPresses = RECORDED_SESSION_KEYDOWNS.filter(({ key }) => key === 'Enter')

    expect(terminalInput.mock.calls).toEqual([])
    // Recorded bytes carry one newline per Enter press and none inside 르-겠-네.
    expect(RECORDED_ONDATA_HEX.filter((hex) => hex === CARRIAGE_RETURN_HEX)).toHaveLength(
      enterPresses.length
    )
    expect(RECORDED_ONDATA_HEX.slice(4, 7)).toEqual(['eba5b4', 'eab2a0', 'eb84a4'])
  })

  it('still routes the same session ordinary keydowns to shortcut policy', () => {
    replayKeyDowns(RECORDED_ORDINARY_KEYDOWNS)

    expect(RECORDED_ORDINARY_KEYDOWNS).toHaveLength(9)
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(9)
    // Three Enters precede it; the fourth ordinary keydown is hello's `h`.
    expect(shortcutPolicy.resolve).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        key: 'h',
        keyCode: 72,
        shiftKey: false,
        isComposing: false
      }),
      ...POLICY_ARGS,
      'orca-first'
    )
  })

  it('still emits the Windows Shift+Enter newline for an ordinary Shift+Enter', () => {
    const shiftEnter = event({
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      shiftKey: true
    })

    expect(actualResolveTerminalShortcutAction(shiftEnter, ...POLICY_ARGS)).toEqual({
      type: 'sendInput',
      data: WINDOWS_SHIFT_ENTER_NEWLINE
    })
  })
})
