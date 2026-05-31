import { describe, expect, it } from 'vitest'
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
