import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('terminal readline input-source shortcuts', () => {
  it.each([
    { inputSource: 'ABC', key: 'a', code: 'KeyA', data: '\x01' },
    { inputSource: 'Korean', key: 'ㅁ', code: 'KeyA', data: '\x01' },
    { inputSource: 'Japanese', key: 'ち', code: 'KeyA', data: '\x01' },
    { inputSource: 'Chinese Pinyin', key: 'a', code: 'KeyA', data: '\x01' },
    { inputSource: 'Russian', key: 'ф', code: 'KeyA', data: '\x01' },
    { inputSource: 'ABC', key: 'e', code: 'KeyE', data: '\x05' },
    { inputSource: 'Korean', key: 'ㄷ', code: 'KeyE', data: '\x05' },
    { inputSource: 'Japanese', key: 'い', code: 'KeyE', data: '\x05' },
    { inputSource: 'Chinese Pinyin', key: 'e', code: 'KeyE', data: '\x05' },
    { inputSource: 'Russian', key: 'у', code: 'KeyE', data: '\x05' }
  ])('sends Ctrl+A/E by physical code for $inputSource', ({ key, code, data }) => {
    expect(resolveTerminalShortcutAction(event({ key, code, ctrlKey: true }), true)).toEqual({
      type: 'sendReadlineLineBoundary',
      data
    })
  })

  it.each([{ metaKey: true }, { altKey: true }, { shiftKey: true }])(
    'does not treat modified Ctrl+KeyA as a readline boundary',
    (modifiers) => {
      expect(
        resolveTerminalShortcutAction(
          event({ key: 'ㅁ', code: 'KeyA', ctrlKey: true, ...modifiers }),
          true
        )
      ).toBeNull()
    }
  )

  it('leaves Ctrl+A/E to a kitty-protocol terminal', () => {
    for (const input of [
      event({ key: 'ㅁ', code: 'KeyA', ctrlKey: true }),
      event({ key: 'ㄷ', code: 'KeyE', ctrlKey: true })
    ]) {
      expect(
        resolveTerminalShortcutAction(
          input,
          true,
          'false',
          0,
          false,
          undefined,
          undefined,
          () => true
        )
      ).toBeNull()
    }
  })
})
