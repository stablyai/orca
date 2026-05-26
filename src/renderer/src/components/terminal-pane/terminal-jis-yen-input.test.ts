import { describe, expect, it } from 'vitest'
import { resolveTerminalJisYenInput, type TerminalJisYenInputEvent } from './terminal-jis-yen-input'

function event(overrides: Partial<TerminalJisYenInputEvent>): TerminalJisYenInputEvent {
  return {
    type: 'keydown',
    key: '¥',
    code: 'IntlYen',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

describe('resolveTerminalJisYenInput', () => {
  const enabledOnMac = { enabled: true, isMac: true }

  it('translates a plain physical JIS Yen keydown to backslash on macOS', () => {
    expect(resolveTerminalJisYenInput(event({}), enabledOnMac)).toEqual({
      type: 'input',
      data: '\\'
    })
  })

  it('suppresses companion events after the translated keydown', () => {
    expect(resolveTerminalJisYenInput(event({ type: 'keypress' }), enabledOnMac)).toEqual({
      type: 'suppress'
    })
    expect(resolveTerminalJisYenInput(event({ type: 'keyup' }), enabledOnMac)).toEqual({
      type: 'suppress'
    })
  })

  it('does not rewrite arbitrary yen text from another physical key', () => {
    expect(resolveTerminalJisYenInput(event({ code: 'KeyY' }), enabledOnMac)).toBeNull()
  })

  it('does not rewrite modified JIS Yen chords', () => {
    const modifiedCases = [
      event({ metaKey: true }),
      event({ ctrlKey: true }),
      event({ altKey: true }),
      event({ shiftKey: true })
    ]

    for (const input of modifiedCases) {
      expect(resolveTerminalJisYenInput(input, enabledOnMac)).toBeNull()
    }
  })

  it('is gated by both the user setting and macOS', () => {
    expect(resolveTerminalJisYenInput(event({}), { enabled: false, isMac: true })).toBeNull()
    expect(resolveTerminalJisYenInput(event({}), { enabled: true, isMac: false })).toBeNull()
  })
})
