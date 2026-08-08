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

// Source: .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/NL-ctrl-space.json
// SHA-256: f423acaa69ac6f8490b352859de4e363e34307137885be64869ad674d78cec98
const COMPOSING_CTRL_SPACE_KEYDOWNS = [
  event({
    key: 'Control',
    code: 'ControlLeft',
    keyCode: 17,
    ctrlKey: true,
    isComposing: true
  })
]

// Source: .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/NL-ctrl-idle.json
// SHA-256: 83fb24d843e43fda3acdee78c758fafcf0adabb0d59d59ab2f7635d9fd24ac1e
const IDLE_CTRL_SPACE_KEYDOWNS = [
  event({ key: 'Control', code: 'ControlLeft', keyCode: 17, ctrlKey: true })
]

// Bound: this trace uses MS Korean; STA-3129's reporter used MS Pinyin. The mode-switch mechanism and CSI-u shape are shared, but the IME differs.
describe('Windows IME mode-switch terminal submit', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model v1.4.163's ctrl branch behind the ownership guard.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.isComposing && keyboardEvent.ctrlKey
        ? { type: 'sendInput', data: '\x1b[13;5u' }
        : null
    )
  })

  it('does not turn the recorded composing Ctrl+Space gesture into a submit', () => {
    const terminalInput = replayKeyDowns(COMPOSING_CTRL_SPACE_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b[13;5u')
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
  })

  it('lets the IME-idle Ctrl+Space control follow shortcut policy exactly once', () => {
    const terminalInput = replayKeyDowns(IDLE_CTRL_SPACE_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b[13;5u')
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(1)
    expect(shortcutPolicy.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'Control',
        code: 'ControlLeft',
        keyCode: 17,
        ctrlKey: true,
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
