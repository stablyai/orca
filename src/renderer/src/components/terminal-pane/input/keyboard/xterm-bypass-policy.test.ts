import { describe, expect, it } from 'vitest'
import { event } from './xterm-bypass-event-fixture'
import { shouldBypassXtermKeyboardEvent } from './xterm-bypass-policy'

describe('shouldBypassXtermKeyboardEvent app-owned copy chords', () => {
  it('lets unselected Ctrl+Shift+C reach xterm on Linux/Windows when Kitty keyboard mode is active', () => {
    const options = { isMac: false, hasSelection: false, kittyKeyboardFlags: 1 }

    expect(
      shouldBypassXtermKeyboardEvent(
        event({ type: 'keydown', key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        options
      )
    ).toBe(false)
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ type: 'keyup', key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }),
        options
      )
    ).toBe(false)
    expect(
      shouldBypassXtermKeyboardEvent(
        event({ type: 'keydown', key: 'C', code: 'KeyJ', ctrlKey: true, shiftKey: true }),
        options
      )
    ).toBe(false)
  })

  it('bypasses Ctrl+Shift+C on Linux/Windows when text is selected, Kitty mode is off, or already handled', () => {
    const chord = event({ type: 'keydown', key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true })

    expect(
      shouldBypassXtermKeyboardEvent(chord, {
        isMac: false,
        hasSelection: true,
        kittyKeyboardFlags: 1
      })
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(chord, {
        isMac: false,
        hasSelection: false,
        kittyKeyboardFlags: 0
      })
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(event({ ...chord, defaultPrevented: true }), {
        isMac: false,
        hasSelection: false,
        kittyKeyboardFlags: 1
      })
    ).toBe(true)
  })

  it('preserves unselected Cmd+C Kitty pass-through on macOS', () => {
    const chord = event({ type: 'keydown', key: 'c', code: 'KeyC', metaKey: true })

    expect(
      shouldBypassXtermKeyboardEvent(chord, {
        isMac: true,
        hasSelection: false,
        kittyKeyboardFlags: 1
      })
    ).toBe(false)
    expect(
      shouldBypassXtermKeyboardEvent(chord, {
        isMac: true,
        hasSelection: true,
        kittyKeyboardFlags: 1
      })
    ).toBe(true)
    expect(
      shouldBypassXtermKeyboardEvent(chord, {
        isMac: true,
        hasSelection: false,
        kittyKeyboardFlags: 0
      })
    ).toBe(true)
  })
})
