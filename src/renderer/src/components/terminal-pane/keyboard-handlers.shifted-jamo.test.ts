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
const SHIFTED_JAMO_KEYDOWNS = [
  event({ key: 'Process', keyCode: 229, shiftKey: true, isComposing: true })
]

// Source: .tmp/ime-handoff/swarm-scratch/win-wave4/evidence/w5/NL-latin-shifted.json
// SHA-256: 431416e7967e96e1541886ac210b27f4cbad21e4462530259d4930a766ee5c67
const ORDINARY_SHIFTED_JAMO_KEY_KEYDOWNS = [
  event({ key: 'T', code: 'KeyT', keyCode: 84, shiftKey: true })
]

describe('Windows shifted jamo terminal input', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model v1.4.163's code-blind composition classifier behind the ownership guard.
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.isComposing && keyboardEvent.shiftKey
        ? { type: 'sendInput', data: '\x1b\r' }
        : null
    )
  })

  it('does not synthesize Enter from the recorded shifted jamo keydowns', () => {
    const terminalInput = replayKeyDowns(SHIFTED_JAMO_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b\r')
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
  })

  it('lets the ordinary shifted jamo key follow shortcut policy', () => {
    const terminalInput = replayKeyDowns(ORDINARY_SHIFTED_JAMO_KEY_KEYDOWNS)

    expect(terminalInput).not.toHaveBeenCalledWith('\x1b\r')
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(1)
    expect(shortcutPolicy.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        key: 'T',
        code: 'KeyT',
        keyCode: 84,
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
