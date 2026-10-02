import { describe, it, expect } from 'vitest'
import {
  chatFontScaleActionForEvent,
  decreaseChatFontScale,
  increaseChatFontScale,
  MAX_CHAT_FONT_SCALE,
  MIN_CHAT_FONT_SCALE
} from './native-chat-font-scale'

type Combo = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey'>

function combo(overrides: Partial<Combo>): Combo {
  return { key: '=', metaKey: false, ctrlKey: false, ...overrides }
}

describe('increase/decreaseChatFontScale', () => {
  it('steps up by a tenth without drift', () => {
    expect(increaseChatFontScale(1)).toBe(1.1)
    expect(increaseChatFontScale(1.1)).toBe(1.2)
  })

  it('steps down by a tenth without drift', () => {
    expect(decreaseChatFontScale(1)).toBe(0.9)
    expect(decreaseChatFontScale(0.9)).toBe(0.8)
  })

  it('does not exceed the max when stepping up at the ceiling', () => {
    expect(increaseChatFontScale(MAX_CHAT_FONT_SCALE)).toBe(MAX_CHAT_FONT_SCALE)
  })

  it('does not drop below the min when stepping down at the floor', () => {
    expect(decreaseChatFontScale(MIN_CHAT_FONT_SCALE)).toBe(MIN_CHAT_FONT_SCALE)
  })
})

describe('chatFontScaleActionForEvent', () => {
  it('maps Cmd+= to increase on Mac', () => {
    expect(chatFontScaleActionForEvent(combo({ key: '=', metaKey: true }), true)).toBe('increase')
  })

  it('maps Cmd++ (shifted equals) to increase on Mac', () => {
    expect(chatFontScaleActionForEvent(combo({ key: '+', metaKey: true }), true)).toBe('increase')
  })

  it('maps Cmd+- to decrease on Mac', () => {
    expect(chatFontScaleActionForEvent(combo({ key: '-', metaKey: true }), true)).toBe('decrease')
  })

  it('maps Cmd+0 to reset on Mac', () => {
    expect(chatFontScaleActionForEvent(combo({ key: '0', metaKey: true }), true)).toBe('reset')
  })

  it('maps Ctrl+= to increase on Windows/Linux', () => {
    expect(chatFontScaleActionForEvent(combo({ key: '=', ctrlKey: true }), false)).toBe('increase')
  })

  it('ignores the wrong primary modifier on Mac', () => {
    expect(chatFontScaleActionForEvent(combo({ key: '=', ctrlKey: true }), true)).toBeNull()
  })

  it('ignores Cmd+Ctrl chords', () => {
    expect(
      chatFontScaleActionForEvent(combo({ key: '=', metaKey: true, ctrlKey: true }), true)
    ).toBeNull()
  })

  it('returns null for an unrelated key', () => {
    expect(chatFontScaleActionForEvent(combo({ key: 'a', metaKey: true }), true)).toBeNull()
  })

  it('returns null without a primary modifier', () => {
    expect(chatFontScaleActionForEvent(combo({ key: '=' }), true)).toBeNull()
  })
})
