import { describe, expect, it } from 'vitest'
import { KEYBINDING_DEFINITIONS } from './keybindings'
import {
  capturedDigitChordsFromSymbolicHotkeysJson,
  findMacSystemHotkeyConflicts,
  type MacCapturedDigitChord
} from './macos-symbolic-hotkeys'

const CONTROL_MASK = 0x40000
const OPTION_MASK = 0x80000
const SHIFT_MASK = 0x20000

function hotkeyEntry(keycode: number, mask: number, enabled = true): unknown {
  return { enabled, value: { type: 'standard', parameters: [65535, keycode, mask] } }
}

function chord(
  digit: number,
  overrides: Partial<MacCapturedDigitChord> = {}
): MacCapturedDigitChord {
  return { digit, meta: false, control: true, alt: false, shift: false, ...overrides }
}

describe('capturedDigitChordsFromSymbolicHotkeysJson', () => {
  it('parses enabled Switch to Desktop entries and skips disabled ones', () => {
    const chords = capturedDigitChordsFromSymbolicHotkeysJson({
      AppleSymbolicHotKeys: {
        '118': hotkeyEntry(18, CONTROL_MASK),
        '119': hotkeyEntry(19, CONTROL_MASK),
        '120': hotkeyEntry(20, CONTROL_MASK, false)
      }
    })
    expect(chords).toEqual([chord(1), chord(2)])
  })

  it('decodes option and shift modifier masks', () => {
    const chords = capturedDigitChordsFromSymbolicHotkeysJson({
      AppleSymbolicHotKeys: { '118': hotkeyEntry(18, CONTROL_MASK | OPTION_MASK | SHIFT_MASK) }
    })
    expect(chords).toEqual([chord(1, { alt: true, shift: true })])
  })

  it('skips unrecognized keycodes and malformed entries', () => {
    const chords = capturedDigitChordsFromSymbolicHotkeysJson({
      AppleSymbolicHotKeys: {
        // Why: a rebound non-digit chord (keycode 49 = Space) must not be misread as a digit.
        '118': hotkeyEntry(49, CONTROL_MASK),
        '119': { enabled: true },
        '120': { enabled: true, value: { parameters: 'bogus' } }
      }
    })
    expect(chords).toEqual([])
  })

  it('returns empty for missing or non-object domains', () => {
    expect(capturedDigitChordsFromSymbolicHotkeysJson(null)).toEqual([])
    expect(capturedDigitChordsFromSymbolicHotkeysJson({})).toEqual([])
    expect(capturedDigitChordsFromSymbolicHotkeysJson({ AppleSymbolicHotKeys: 'bogus' })).toEqual(
      []
    )
  })
})

describe('findMacSystemHotkeyConflicts', () => {
  it('flags the default darwin tab range against captured Ctrl+digits, not the Cmd workspace range', () => {
    const conflicts = findMacSystemHotkeyConflicts(KEYBINDING_DEFINITIONS, 'darwin', undefined, [
      chord(1),
      chord(2)
    ])
    expect(conflicts).toEqual([
      { actionId: 'tab.selectByIndex', binding: 'Ctrl+1', capturedBindings: ['Ctrl+1', 'Ctrl+2'] }
    ])
  })

  it('covers every digit of the 1-9 range from the stored representative', () => {
    const conflicts = findMacSystemHotkeyConflicts(KEYBINDING_DEFINITIONS, 'darwin', undefined, [
      chord(7)
    ])
    expect(conflicts).toEqual([
      { actionId: 'tab.selectByIndex', binding: 'Ctrl+1', capturedBindings: ['Ctrl+7'] }
    ])
  })

  it('clears the conflict when the user remaps away from the captured modifiers', () => {
    const conflicts = findMacSystemHotkeyConflicts(
      KEYBINDING_DEFINITIONS,
      'darwin',
      { 'tab.selectByIndex': ['Ctrl+Cmd+1'] },
      [chord(1), chord(2)]
    )
    expect(conflicts).toEqual([])
  })

  it('flags a remapped workspace range when Spaces chords use the same modifiers', () => {
    const conflicts = findMacSystemHotkeyConflicts(
      KEYBINDING_DEFINITIONS,
      'darwin',
      { 'tab.selectByIndex': [], 'workspace.selectByIndex': ['Ctrl+1'] },
      [chord(3)]
    )
    expect(conflicts).toEqual([
      { actionId: 'workspace.selectByIndex', binding: 'Ctrl+1', capturedBindings: ['Ctrl+3'] }
    ])
  })

  it('returns empty without captured chords', () => {
    expect(findMacSystemHotkeyConflicts(KEYBINDING_DEFINITIONS, 'darwin', undefined, [])).toEqual(
      []
    )
  })
})
