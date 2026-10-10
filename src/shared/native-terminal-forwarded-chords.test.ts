import { describe, expect, it } from 'vitest'
import {
  buildNativeTerminalForwardedChords,
  isNativeTerminalForwardedChord,
  type NativeTerminalForwardedChord
} from './native-terminal-forwarded-chords'
import { NS_COMMAND, NS_CONTROL, NS_OPTION, NS_SHIFT } from './native-terminal-keys'
import { KEYBINDING_DEFINITIONS, getDefaultBindings, isDoubleTapBinding } from './keybindings'

const TAB = 0x30
const PAGE_UP = 0x74
const PAGE_DOWN = 0x79
const LEFT = 0x7b

function named(keyCode: number, modifierFlags: number): NativeTerminalForwardedChord {
  return { keyCode, character: '', modifierFlags }
}

function character(value: string, modifierFlags: number): NativeTerminalForwardedChord {
  return { keyCode: -1, character: value, modifierFlags }
}

describe('buildNativeTerminalForwardedChords', () => {
  it('claims the default Ctrl tab chords, the switcher reverse and every tab index', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: undefined,
      terminalShortcutPolicy: 'orca-first'
    })
    expect(chords).toEqual(
      expect.arrayContaining([
        named(TAB, NS_CONTROL),
        named(TAB, NS_CONTROL | NS_SHIFT),
        named(PAGE_DOWN, NS_CONTROL),
        named(PAGE_UP, NS_CONTROL),
        ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) =>
          character(digit, NS_CONTROL)
        )
      ])
    )
  })

  it('leaves Command chords, editor-only chords and plain typing to their existing paths', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: undefined,
      terminalShortcutPolicy: 'orca-first'
    })
    // Alt+Z is editor.toggleWordWrap, F7 editor.nextChange: neither runs over a terminal.
    expect(chords).not.toContainEqual(character('z', NS_OPTION))
    expect(chords.some((chord) => chord.keyCode === 0x62)).toBe(false)
    expect(chords.every((chord) => chord.modifierFlags !== 0)).toBe(true)
  })

  it('yields chords the terminal-first policy hands back to the terminal', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: undefined,
      terminalShortcutPolicy: 'terminal-first'
    })
    expect(chords).toContainEqual(named(TAB, NS_CONTROL))
    expect(chords).not.toContainEqual(character('1', NS_CONTROL))
  })

  it('follows user bindings, including removed defaults', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: {
        'terminal.focusPreviousPane': ['Ctrl+Alt+H'],
        'terminal.focusNextPane': ['Ctrl+Alt+ArrowLeft', 'Ctrl+Alt+BracketRight'],
        'tab.nextTerminal': []
      },
      terminalShortcutPolicy: 'orca-first'
    })
    expect(chords).toEqual(
      expect.arrayContaining([
        character('h', NS_CONTROL | NS_OPTION),
        named(LEFT, NS_CONTROL | NS_OPTION),
        character(']', NS_CONTROL | NS_OPTION)
      ])
    )
    expect(chords).not.toContainEqual(named(PAGE_DOWN, NS_CONTROL))
  })

  it('watches both keys of a double-tap binding modifier, Mod resolving to Command', () => {
    const chords = buildNativeTerminalForwardedChords({
      overrides: {
        'sidebar.left.toggle': ['DoubleTap+Shift'],
        'sidebar.right.toggle': ['DoubleTap+Mod']
      },
      terminalShortcutPolicy: 'orca-first'
    })
    expect(chords).toEqual(
      expect.arrayContaining([
        named(0x38, NS_SHIFT),
        named(0x3c, NS_SHIFT),
        named(0x37, NS_COMMAND),
        named(0x36, NS_COMMAND)
      ])
    )
  })
})

describe('double-tap bindings', () => {
  // A bare-modifier gesture over the native view never leaves Ghostty; forwarding one would
  // need replaying the taps to Orca's detectors. No default needs it today.
  it('has no default double-tap binding that a native terminal would have to forward', () => {
    const doubleTaps = KEYBINDING_DEFINITIONS.flatMap((definition) =>
      (['darwin', 'linux', 'win32'] as const).flatMap((platform) =>
        getDefaultBindings(definition, platform)
          .filter(isDoubleTapBinding)
          .map((binding) => `${definition.id}:${binding}`)
      )
    )
    expect(doubleTaps).toEqual([])
  })
})

describe('isNativeTerminalForwardedChord', () => {
  it('accepts the IPC shape and rejects anything else', () => {
    expect(isNativeTerminalForwardedChord(named(TAB, NS_CONTROL))).toBe(true)
    expect(isNativeTerminalForwardedChord(character('h', NS_CONTROL))).toBe(true)
    expect(isNativeTerminalForwardedChord({ keyCode: 1.5, character: '', modifierFlags: 0 })).toBe(
      false
    )
    expect(isNativeTerminalForwardedChord({ keyCode: 1, character: 'ab', modifierFlags: 0 })).toBe(
      false
    )
    expect(isNativeTerminalForwardedChord(null)).toBe(false)
  })
})
