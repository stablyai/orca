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
  it('steps by one pixel and clamps at both limits', () => {
    expect(chatFontSizeForAction(undefined, 'increase')).toEqual({ fontSize: 15 })
    expect(chatFontSizeForAction({ fontSize: 20 }, 'increase')).toEqual({ fontSize: 20 })
    expect(chatFontSizeForAction({ fontSize: 12 }, 'decrease')).toEqual({ fontSize: 12 })
    expect(chatFontSizeForAction({ fontSize: 15 }, 'decrease')).toBeUndefined()
  })
  it('reset removes only text size and preserves code size and width', () => {
    expect(
      chatFontSizeForAction({ fontSize: 18, codeFontSize: 16, width: 'wide' }, 'reset')
    ).toEqual({ codeFontSize: 16, width: 'wide' })
    expect(chatFontSizeForAction({ fontSize: 18 }, 'reset')).toBeUndefined()
  })
})

describe('chatFontSizeActionForEvent', () => {
  it('maps Cmd+= to increase on Mac', () => {
    expect(chatFontSizeActionForEvent(combo({ metaKey: true }), 'darwin')).toBe('increase')
  })

  it('maps Cmd++ (shifted equals) to increase on Mac', () => {
    expect(
      chatFontSizeActionForEvent(combo({ key: '+', metaKey: true, shiftKey: true }), 'darwin')
    ).toBe('increase')
  })

  it('maps Cmd+- to decrease on Mac', () => {
    expect(
      chatFontSizeActionForEvent(combo({ key: '-', code: 'Minus', metaKey: true }), 'darwin')
    ).toBe('decrease')
  })

  it('maps Cmd+0 to reset on Mac', () => {
    expect(
      chatFontSizeActionForEvent(combo({ key: '0', code: 'Digit0', metaKey: true }), 'darwin')
    ).toBe('reset')
  })

  it('maps Ctrl+= to increase on Windows/Linux', () => {
    expect(chatFontSizeActionForEvent(combo({ ctrlKey: true }), 'win32')).toBe('increase')
  })

  it('ignores the wrong primary modifier on Mac', () => {
    expect(chatFontSizeActionForEvent(combo({ ctrlKey: true }), 'darwin')).toBeNull()
  })

  it('ignores Cmd+Ctrl chords', () => {
    expect(chatFontSizeActionForEvent(combo({ metaKey: true, ctrlKey: true }), 'darwin')).toBeNull()
  })

  it('returns null for an unrelated key', () => {
    expect(
      chatFontSizeActionForEvent(combo({ key: 'a', code: 'KeyA', metaKey: true }), 'darwin')
    ).toBeNull()
  })

  it('returns null without a primary modifier', () => {
    expect(chatFontSizeActionForEvent(combo({}), 'darwin')).toBeNull()
  })

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
