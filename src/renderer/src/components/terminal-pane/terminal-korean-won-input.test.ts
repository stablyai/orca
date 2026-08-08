import { describe, expect, it } from 'vitest'
import {
  resolveTerminalKoreanWonInput,
  type TerminalKoreanWonInputEvent
} from './terminal-korean-won-input'

function event(overrides: Partial<TerminalKoreanWonInputEvent>): TerminalKoreanWonInputEvent {
  return {
    type: 'keydown',
    key: '₩',
    code: 'Backquote',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('resolveTerminalKoreanWonInput', () => {
  const enabledOnMacKorean = { enabled: true, isMac: true, isKoreanKeyboard: true }

  it('translates a plain backquote keystroke to backquote on a Korean keyboard', () => {
    expect(resolveTerminalKoreanWonInput(event({}), enabledOnMacKorean)).toEqual({
      type: 'input',
      data: '`'
    })
  })

  it('rewrites regardless of the character the Korean layout produces at that key', () => {
    // Why: the rule keys on the keystroke position alone — 두벌식/세벌식 390
    // produce ₩, 세벌식 최종 produces *, and the English state produces `.
    for (const key of ['₩', '*', '`', '~']) {
      expect(resolveTerminalKoreanWonInput(event({ key }), enabledOnMacKorean)).toEqual({
        type: 'input',
        data: '`'
      })
    }
  })

  it('suppresses companion events after the translated keydown', () => {
    expect(resolveTerminalKoreanWonInput(event({ type: 'keypress' }), enabledOnMacKorean)).toEqual({
      type: 'suppress'
    })
    expect(resolveTerminalKoreanWonInput(event({ type: 'keyup' }), enabledOnMacKorean)).toEqual({
      type: 'suppress'
    })
  })

  it('leaves IME-processed keydowns (keyCode 229) to the IME', () => {
    expect(resolveTerminalKoreanWonInput(event({ keyCode: 229 }), enabledOnMacKorean)).toBeNull()
    expect(
      resolveTerminalKoreanWonInput(event({ type: 'keyup', keyCode: 229 }), enabledOnMacKorean)
    ).toBeNull()
  })

  it('does not rewrite other physical keys', () => {
    for (const code of ['Backslash', 'KeyY', 'Digit1', 'IntlBackslash']) {
      expect(resolveTerminalKoreanWonInput(event({ code }), enabledOnMacKorean)).toBeNull()
    }
  })

  it('does not rewrite modified backquote chords', () => {
    const modifiedCases = [
      event({ metaKey: true }),
      event({ ctrlKey: true }),
      event({ altKey: true }),
      event({ shiftKey: true })
    ]

    for (const input of modifiedCases) {
      expect(resolveTerminalKoreanWonInput(input, enabledOnMacKorean)).toBeNull()
    }
  })

  it('is gated by the user setting, macOS, and a Korean keyboard', () => {
    expect(
      resolveTerminalKoreanWonInput(event({}), {
        enabled: false,
        isMac: true,
        isKoreanKeyboard: true
      })
    ).toBeNull()
    expect(
      resolveTerminalKoreanWonInput(event({}), {
        enabled: true,
        isMac: false,
        isKoreanKeyboard: true
      })
    ).toBeNull()
    expect(
      resolveTerminalKoreanWonInput(event({}), {
        enabled: true,
        isMac: true,
        isKoreanKeyboard: false
      })
    ).toBeNull()
  })
})
