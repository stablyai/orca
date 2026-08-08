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

/** One recorded DOM step that can reach the PTY: a keydown, or xterm's commit of a composition. */
type RecordedStep = { keydown: RecordedKeyboardEvent } | { compositionCommit: string }

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

/** Concatenated PTY bytes, so the recorded `matchedHex` can be asserted as a whole. */
function replayRecordedSession(steps: RecordedStep[]): string {
  let ptyBytes = ''

  for (const step of steps) {
    if ('compositionCommit' in step) {
      ptyBytes += step.compositionCommit
      continue
    }
    const action = resolveTerminalKeyboardShortcutAction(
      step.keydown,
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
      ptyBytes += action.data
      continue
    }
    // Unclaimed printable keydowns are what xterm itself routes to the PTY.
    if (step.keydown.key.length === 1) {
      ptyBytes += step.keydown.key
    }
  }

  return ptyBytes
}

// Source: .tmp/ime-handoff/evidence/windows-11946-repair/11946-repair-baseline-v4.json
// SHA-256: c7846c89c2cd12c1282e5367caf0708f89a6eec1922a81950987f3ec41432b15
// Native Microsoft Pinyin, VK_LSHIFT scan 42. Records 0/14/26/38/50 are the five jamo
// keydowns, 62 is the Shift that commits, 69 is the compositionend.
const PINYIN_COMMIT_SESSION: RecordedStep[] = [
  { keydown: event({ key: 'Process', keyCode: 229 }) },
  { keydown: event({ key: 'Process', keyCode: 229, isComposing: true }) },
  { keydown: event({ key: 'Process', keyCode: 229, isComposing: true }) },
  { keydown: event({ key: 'Process', keyCode: 229, isComposing: true }) },
  { keydown: event({ key: 'Process', keyCode: 229, isComposing: true }) },
  {
    keydown: event({
      key: 'Process',
      code: 'ShiftLeft',
      keyCode: 229,
      shiftKey: true,
      isComposing: true
    })
  },
  { compositionCommit: 'nihao' }
]

// Recorded PTY readback for that session, from the same bundle's
// 11946-repair-baseline-v4.pty.json (SHA-256
// 23fe6a5f1be46852c47659aca8b98aa9de8863670732ac53cf4330ce07291318): matchedHex "6e6968616f".
const RECORDED_PINYIN_PTY = 'nihao'

// Source: .tmp/ime-handoff/evidence/windows-11946-repair/11946-repair-control.json
// SHA-256: ca9a024bfcaeb7ab3a9595cd817249c7d18798ab18b333fdd36e2c9f4ee41564
// Same host and same trailing Left Shift, en-US, zero composition events.
const ORDINARY_LATIN_SESSION: RecordedStep[] = [
  { keydown: event({ key: 'n', keyCode: 78 }) },
  { keydown: event({ key: 'i', keyCode: 73 }) },
  { keydown: event({ key: 'h', keyCode: 72 }) },
  { keydown: event({ key: 'a', keyCode: 65 }) },
  { keydown: event({ key: 'o', keyCode: 79 }) },
  { keydown: event({ key: 'Shift', code: 'ShiftLeft', keyCode: 16, shiftKey: true }) }
]

// 11946-repair-control.pty.json (SHA-256
// f372311b8bf0086df2fd84dd0ee31ce3ec421d2156b177afc138e7a0aaea08a5): matchedHex "6e6968616f".
const RECORDED_LATIN_PTY = 'nihao'

describe('Windows Pinyin Shift commit', () => {
  beforeEach(() => {
    shortcutPolicy.resolve.mockReset()
    // Model the pre-#12265 broad Process/229 classifier behind the ownership guard; it is
    // what turned this recorded Shift into ESC CR (mutant PTY hex 6e6968616f1b0d).
    shortcutPolicy.resolve.mockImplementation((keyboardEvent: RecordedKeyboardEvent) =>
      keyboardEvent.isComposing && keyboardEvent.shiftKey
        ? { type: 'sendInput', data: '\x1b\r' }
        : null
    )
  })

  it('commits the recorded composition once and sends no newline', () => {
    const ptyBytes = replayRecordedSession(PINYIN_COMMIT_SESSION)

    expect(ptyBytes.split('nihao')).toHaveLength(2)
    expect(ptyBytes).not.toContain('\r')
    expect(ptyBytes).toBe(RECORDED_PINYIN_PTY)
    expect(shortcutPolicy.resolve).not.toHaveBeenCalled()
  })

  it('lets the ordinary Latin session reach the PTY through shortcut policy', () => {
    const ptyBytes = replayRecordedSession(ORDINARY_LATIN_SESSION)

    expect(ptyBytes.split('nihao')).toHaveLength(2)
    expect(ptyBytes).not.toContain('\r')
    expect(ptyBytes).toBe(RECORDED_LATIN_PTY)
    expect(shortcutPolicy.resolve).toHaveBeenCalledTimes(6)
    expect(shortcutPolicy.resolve).toHaveBeenLastCalledWith(
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
