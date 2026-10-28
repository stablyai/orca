import { describe, it, expect } from 'vitest'
import { chatFontSizeActionForEvent, chatFontSizeForAction } from './native-chat-font-size'

type Combo = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>

function combo(overrides: Partial<Combo>): Combo {
  return {
    key: '=',
    code: 'Equal',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides
  }
}

describe('chatFontSizeForAction', () => {
  it('reset removes only text size and preserves code size and width', () => {
    expect(
      chatFontSizeForAction({ fontSize: 18, codeFontSize: 16, width: 'wide' }, 'reset')
    ).toEqual({ codeFontSize: 16, width: 'wide' })
    expect(chatFontSizeForAction({ fontSize: 18 }, 'reset')).toBeUndefined()
  })
})

describe('chatFontSizeActionForEvent', () => {
  it('uses configured bindings and ignores disabled defaults or extra modifiers', () => {
    const overrides = {
      'zoom.in': ['Mod+Y'],
      'zoom.out': ['Mod+U'],
      'zoom.reset': []
    }
    expect(
      chatFontSizeActionForEvent(
        combo({ key: 'y', code: 'KeyY', ctrlKey: true }),
        'linux',
        overrides
      )
    ).toBe('increase')
    expect(
      chatFontSizeActionForEvent(
        combo({ key: 'u', code: 'KeyU', ctrlKey: true }),
        'linux',
        overrides
      )
    ).toBe('decrease')
    expect(chatFontSizeActionForEvent(combo({ ctrlKey: true }), 'linux', overrides)).toBeNull()
    expect(
      chatFontSizeActionForEvent(
        combo({ key: '0', code: 'Digit0', ctrlKey: true }),
        'linux',
        overrides
      )
    ).toBeNull()
    expect(
      chatFontSizeActionForEvent(
        combo({ key: 'y', code: 'KeyY', ctrlKey: true, altKey: true }),
        'linux',
        overrides
      )
    ).toBeNull()
    expect(
      chatFontSizeActionForEvent(
        combo({ key: '-', code: 'Minus', ctrlKey: true, shiftKey: true }),
        'linux'
      )
    ).toBeNull()
  })
})
