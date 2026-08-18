import { describe, expect, it } from 'vitest'
import { KEYBINDING_DEFINITIONS } from './keybindings'
import {
  capturedDigitRowChordsFromSymbolicHotkeysJson,
  findMacSystemHotkeyConflicts,
  resolveCapturedDigitChordsForLayout,
  type MacCapturedDigitChord,
  type MacCapturedDigitRowChord,
  type MacDigitRowCode
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

describe('capturedDigitRowChordsFromSymbolicHotkeysJson', () => {
  it('parses enabled Switch to Desktop entries and skips disabled ones', () => {
    const chords = capturedDigitRowChordsFromSymbolicHotkeysJson({
      AppleSymbolicHotKeys: {
        '118': hotkeyEntry(18, CONTROL_MASK),
        '119': hotkeyEntry(19, CONTROL_MASK),
        '120': hotkeyEntry(20, CONTROL_MASK, false)
      }
    })
    expect(chords).toEqual([physicalChord('Digit1'), physicalChord('Digit2')])
  })

  it('decodes option and shift modifier masks', () => {
    const chords = capturedDigitRowChordsFromSymbolicHotkeysJson({
      AppleSymbolicHotKeys: { '118': hotkeyEntry(18, CONTROL_MASK | OPTION_MASK | SHIFT_MASK) }
    })
    expect(chords).toEqual([physicalChord('Digit1', { alt: true, shift: true })])
  })

  it('skips non-standard, unrecognized, and malformed entries', () => {
    const chords = capturedDigitRowChordsFromSymbolicHotkeysJson({
      AppleSymbolicHotKeys: {
        '118': hotkeyEntry(49, CONTROL_MASK),
        '119': { enabled: true },
        '120': { enabled: true, value: { parameters: 'bogus' } },
        '121': {
          enabled: true,
          value: { type: 'symbolic', parameters: [65535, 18, CONTROL_MASK] }
        },
        '122': {
          enabled: true,
          value: { type: 'standard', parameters: [65535, 18, Number.NaN] }
        },
        '123': {
          enabled: true,
          value: { type: 'standard', parameters: [65535, 18, CONTROL_MASK, 1] }
        }
      }
    })
    expect(chords).toEqual([])
  })

  it('skips chords with modifier bits the matcher cannot represent', () => {
    const chords = capturedDigitRowChordsFromSymbolicHotkeysJson({
      AppleSymbolicHotKeys: { '118': hotkeyEntry(18, CONTROL_MASK | 0x800000) }
    })
    expect(chords).toEqual([])
  })

  it('returns empty for missing or non-object domains', () => {
    expect(capturedDigitRowChordsFromSymbolicHotkeysJson(null)).toEqual([])
    expect(capturedDigitRowChordsFromSymbolicHotkeysJson({})).toEqual([])
    expect(
      capturedDigitRowChordsFromSymbolicHotkeysJson({ AppleSymbolicHotKeys: 'bogus' })
    ).toEqual([])
  })
})

function physicalChord(
  code: MacDigitRowCode,
  overrides: Partial<MacCapturedDigitRowChord> = {}
): MacCapturedDigitRowChord {
  return { code, meta: false, control: true, alt: false, shift: false, ...overrides }
}

describe('resolveCapturedDigitChordsForLayout', () => {
  it('resolves physical keys through a digit-producing layout', () => {
    const values = new Map<MacDigitRowCode, string>([
      ['Digit1', '1'],
      ['Digit2', '2']
    ])
    expect(
      resolveCapturedDigitChordsForLayout(
        [physicalChord('Digit1'), physicalChord('Digit2')],
        (code) => values.get(code)
      )
    ).toEqual([chord(1), chord(2)])
  })

  it('does not equate AZERTY digit-row positions with logical digits', () => {
    expect(resolveCapturedDigitChordsForLayout([physicalChord('Digit1')], () => '&')).toEqual([])
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
