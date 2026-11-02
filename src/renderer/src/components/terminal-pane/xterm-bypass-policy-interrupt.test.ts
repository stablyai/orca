import { afterEach, describe, expect, it } from 'vitest'
import { _setLayoutMapForTests } from '../../lib/keyboard-layout/layout-base-character'
import {
  shouldHandleTerminalInterruptKeyboardEvent,
  shouldSuppressTerminalInterruptKeyup,
  shouldSuppressTerminalModifierKeyboardEvent,
  TERMINAL_INTERRUPT_INPUT,
  type XtermBypassEvent
} from './xterm-bypass-policy'

function event(overrides: Partial<XtermBypassEvent>): XtermBypassEvent {
  return {
    type: 'keydown',
    key: '',
    code: '',
    defaultPrevented: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides
  }
}

// The layout map is module-level cache; leaving one set would leak into later cases.
afterEach(() => _setLayoutMapForTests(null))

describe('shouldHandleTerminalInterruptKeyboardEvent', () => {
  it('exports the ETX byte used for terminal interrupts', () => {
    expect(TERMINAL_INTERRUPT_INPUT).toBe('\x03')
  })

  it('handles macOS Ctrl+C as terminal interrupt even with a selection', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: 'c', code: 'KeyC', ctrlKey: true }), {
        isMac: true,
        hasSelection: true
      })
    ).toBe(true)
  })

  it('does not handle macOS Cmd+C so host copy can bypass xterm', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: 'c', code: 'KeyC', metaKey: true }), {
        isMac: true,
        hasSelection: true
      })
    ).toBe(false)
  })

  it('handles non-Mac Ctrl+C only when there is no selection', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: 'c', code: 'KeyC', ctrlKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe(true)
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: 'c', code: 'KeyC', ctrlKey: true }), {
        isMac: false,
        hasSelection: true
      })
    ).toBe(false)
  })

  it('handles matching Ctrl+C keyup so kitty release sequences do not leak', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(
        event({ type: 'keyup', key: 'c', code: 'KeyC', ctrlKey: true }),
        { isMac: false, hasSelection: false }
      )
    ).toBe(true)
  })

  it('suppresses handled Ctrl+C keyup even after Ctrl was released first', () => {
    expect(
      shouldSuppressTerminalInterruptKeyup(event({ type: 'keyup', key: 'c', code: 'KeyC' }))
    ).toBe(true)
    expect(
      shouldSuppressTerminalInterruptKeyup(
        event({ type: 'keyup', key: 'j', code: 'KeyC', keyCode: 67 })
      )
    ).toBe(false)
  })

  it('handles Ctrl+C by physical key metadata when the logical key is unavailable', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: '', code: 'KeyC', ctrlKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe(true)
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(
        event({ key: 'Unidentified', keyCode: 67, ctrlKey: true }),
        { isMac: true, hasSelection: false }
      )
    ).toBe(true)
  })

  it('does not handle physical KeyC when the logical key is a different letter', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: 'j', code: 'KeyC', ctrlKey: true }), {
        isMac: false,
        hasSelection: false
      })
    ).toBe(false)
  })

  // Non-Latin key glyphs cannot express Ctrl+C; physical KeyC must still reach ETX (#14460).
  it.each([
    ['Korean 2-Set', 'ㅊ'],
    ['Russian', 'с'],
    ['Greek', 'ψ'],
    ['Hangul syllable', '차']
  ])('handles Ctrl+C when %s reports a non-Latin logical key', (_layout, key) => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key, code: 'KeyC', ctrlKey: true }), {
        isMac: true,
        hasSelection: false
      })
    ).toBe(true)
  })

  it('suppresses the matching keyup for a non-Latin Ctrl+C', () => {
    expect(
      shouldSuppressTerminalInterruptKeyup(
        event({ type: 'keyup', key: 'ㅊ', code: 'KeyC', ctrlKey: true })
      )
    ).toBe(true)
  })

  // Latin remaps such as Dvorak keep their reported letter authoritative.
  it('still ignores a Latin layout that maps KeyC to a different ASCII letter', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: 'j', code: 'KeyC', ctrlKey: true }), {
        isMac: true,
        hasSelection: false
      })
    ).toBe(false)
  })

  it('does not handle a non-Latin logical key on a physical key other than KeyC', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(
        event({ key: 'ㅁ', code: 'KeyA', ctrlKey: true }),
        {
          isMac: true,
          hasSelection: false
        }
      )
    ).toBe(false)
  })

  // An IME’s Latin base layout map distinguishes the actual C from a positional guess.
  it('uses the layout map when an IME is layered over a Latin layout', () => {
    _setLayoutMapForTests(new Map([['KeyC', 'c']]))
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(
        event({ key: 'ㅊ', code: 'KeyC', ctrlKey: true }),
        {
          isMac: true,
          hasSelection: false
        }
      )
    ).toBe(true)
  })

  // Korean over Dvorak must honor the base map: physical KeyC is not logical C.
  it('declines when the layout map shows the physical key is not C', () => {
    _setLayoutMapForTests(new Map([['KeyC', 'j']]))
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(
        event({ key: 'ㅊ', code: 'KeyC', ctrlKey: true }),
        {
          isMac: true,
          hasSelection: false
        }
      )
    ).toBe(false)
  })

  // True non-Latin layout maps cannot name C either; fall back to terminal physical-position semantics.
  it('falls back to the physical key when the layout map is itself non-Latin', () => {
    _setLayoutMapForTests(new Map([['KeyC', 'с']]))
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(event({ key: 'с', code: 'KeyC', ctrlKey: true }), {
        isMac: true,
        hasSelection: false
      })
    ).toBe(true)
  })

  it('does not handle modified Ctrl+C chords', () => {
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(
        event({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        { isMac: false, hasSelection: false }
      )
    ).toBe(false)
    expect(
      shouldHandleTerminalInterruptKeyboardEvent(
        event({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }),
        { isMac: true, hasSelection: false }
      )
    ).toBe(false)
  })
})

describe('shouldSuppressTerminalModifierKeyboardEvent', () => {
  it('suppresses standalone modifier events before Kitty can encode them', () => {
    expect(
      shouldSuppressTerminalModifierKeyboardEvent(
        event({ type: 'keydown', key: 'Control', code: 'ControlLeft', ctrlKey: true })
      )
    ).toBe(true)
    expect(
      shouldSuppressTerminalModifierKeyboardEvent(
        event({ type: 'keyup', key: 'Meta', code: 'MetaLeft', metaKey: false })
      )
    ).toBe(true)
  })

  it('does not suppress non-modifier keyboard input', () => {
    expect(
      shouldSuppressTerminalModifierKeyboardEvent(
        event({ type: 'keydown', key: 'c', code: 'KeyC', ctrlKey: true })
      )
    ).toBe(false)
    expect(shouldSuppressTerminalModifierKeyboardEvent(event({ type: 'keypress', key: 'c' }))).toBe(
      false
    )
  })
})
