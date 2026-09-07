// Matching across non-QWERTY, non-Latin, JIS, AltGr, and composed layouts.
import { describe, expect, it } from 'vitest'
import {
  getEffectiveKeybindingsForAction,
  keybindingFromInput,
  keybindingMatchesAction,
  keybindingMatchesInput
} from './keybindings'

describe('keybindings', () => {
  it('matches the default file explorer delete shortcut', () => {
    expect(getEffectiveKeybindingsForAction('fileExplorer.delete', 'darwin')).toEqual([
      'Mod+Backspace',
      'Delete'
    ])
    expect(
      keybindingMatchesAction(
        'fileExplorer.delete',
        { key: 'Delete', code: 'Delete', control: false, meta: false, alt: false, shift: false },
        'linux'
      )
    ).toBe(true)
  })

  it('matches file explorer undo and redo by produced logical key', () => {
    expect(getEffectiveKeybindingsForAction('fileExplorer.undo', 'darwin')).toEqual(['Mod+Z'])
    expect(getEffectiveKeybindingsForAction('fileExplorer.redo', 'darwin')).toEqual(['Mod+Shift+Z'])
    expect(getEffectiveKeybindingsForAction('fileExplorer.redo', 'linux')).toEqual([
      'Mod+Shift+Z',
      'Ctrl+Y'
    ])

    expect(
      keybindingMatchesAction(
        'fileExplorer.undo',
        { key: 'z', code: 'Semicolon', control: false, meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'fileExplorer.undo',
        { key: ';', code: 'KeyZ', control: false, meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'fileExplorer.redo',
        { key: 'Z', code: 'Semicolon', control: false, meta: true, alt: false, shift: true },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'fileExplorer.redo',
        { key: 'y', code: 'KeyF', control: true, meta: false, alt: false, shift: false },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'fileExplorer.redo',
        { key: 'f', code: 'KeyY', control: true, meta: false, alt: false, shift: false },
        'linux'
      )
    ).toBe(false)
  })

  it('matches non-QWERTY shortcuts by the produced logical key', () => {
    const dvorakPhysicalW = {
      key: ',',
      code: 'KeyW',
      control: false,
      meta: true,
      alt: false,
      shift: false
    }
    const dvorakPhysicalComma = {
      key: 'w',
      code: 'Comma',
      control: false,
      meta: true,
      alt: false,
      shift: false
    }

    expect(keybindingMatchesAction('app.settings', dvorakPhysicalW, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('tab.close', dvorakPhysicalW, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('tab.close', dvorakPhysicalComma, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('app.settings', dvorakPhysicalComma, 'darwin')).toBe(false)
    expect(keybindingFromInput(dvorakPhysicalW, 'darwin')).toEqual({
      ok: true,
      value: 'Mod+Comma'
    })
    expect(keybindingFromInput(dvorakPhysicalComma, 'darwin')).toEqual({
      ok: true,
      value: 'Mod+W'
    })
  })

  it('matches letter shortcuts on non-Latin layouts via the physical code (issue #6274)', () => {
    // Cyrillic ЙЦУКЕН: physical C produces the logical key 'с' (Cyrillic es,
    // U+0441) while code stays 'KeyC'. The produced character is not a Latin
    // shortcut letter, so the chord must still match through the physical code.
    const cyrillicCtrlC = {
      key: 'с',
      code: 'KeyC',
      control: true,
      meta: false,
      alt: false,
      shift: false
    }
    expect(keybindingMatchesAction('browser.grabElement', cyrillicCtrlC, 'win32')).toBe(true)
    expect(keybindingMatchesAction('browser.grabElement', cyrillicCtrlC, 'linux')).toBe(true)

    // Ctrl+Shift+C on the same layout (terminal copy) must match too.
    expect(
      keybindingMatchesAction('terminal.copySelection', { ...cyrillicCtrlC, shift: true }, 'win32')
    ).toBe(true)

    // Greek layout: physical P produces 'π' (U+03C0); Ctrl+P must still match.
    expect(
      keybindingMatchesAction(
        'worktree.quickOpen',
        { key: 'π', code: 'KeyP', control: true, meta: false, alt: false, shift: false },
        'win32'
      )
    ).toBe(true)

    // The fallback must not steal a different physical key: Ctrl+V (physical V,
    // Cyrillic 'м') is not Ctrl+C, so grabElement must stay unmatched.
    expect(
      keybindingMatchesAction(
        'browser.grabElement',
        { key: 'м', code: 'KeyV', control: true, meta: false, alt: false, shift: false },
        'win32'
      )
    ).toBe(false)
  })

  it('does not let non-Latin physical fallback hijack AltGr text input (issue #6274)', () => {
    // Windows/Linux AltGr arrives as Ctrl+Alt. A composed character typed via
    // AltGr (e.g. AltGr+C) must remain text input, never an app shortcut.
    // editor.copyContext is Mod+Alt+C, so the modifier state otherwise matches —
    // only the AltGr key gating may keep this from firing.
    expect(
      keybindingMatchesAction(
        'editor.copyContext',
        {
          key: '¢',
          code: 'KeyC',
          control: true,
          meta: false,
          alt: true,
          shift: false
        },
        'win32'
      )
    ).toBe(false)
  })

  it('uses shifted punctuation aliases only while Shift is pressed', () => {
    const shiftedComma = {
      key: '<',
      code: 'Comma',
      control: false,
      meta: true,
      alt: false,
      shift: true
    }

    expect(keybindingMatchesInput('Mod+Shift+Comma', shiftedComma, 'darwin')).toBe(true)
    expect(keybindingFromInput(shiftedComma, 'darwin')).toEqual({
      ok: true,
      value: 'Mod+Shift+Comma'
    })
    expect(
      keybindingMatchesInput(
        'Mod+Comma',
        { ...shiftedComma, code: 'IntlBackslash', shift: false },
        'darwin'
      )
    ).toBe(false)
  })

  it('matches logical bracket shortcuts on JIS keyboards without changing code fallback', () => {
    const jisLeftBracket = {
      key: '[',
      code: 'BracketRight',
      control: false,
      meta: true,
      alt: false,
      shift: false
    }
    const jisRightBracket = {
      key: ']',
      code: 'Backslash',
      control: false,
      meta: true,
      alt: false,
      shift: false
    }
    const jisLeftBracketShifted = { ...jisLeftBracket, key: '{', shift: true }
    const jisRightBracketShifted = { ...jisRightBracket, key: '}', shift: true }

    expect(
      keybindingMatchesAction('tab.previousSameType', jisLeftBracketShifted, 'darwin', {
        'tab.previousSameType': ['Mod+Shift+BracketLeft']
      })
    ).toBe(true)
    expect(
      keybindingMatchesAction('tab.previousSameType', jisRightBracketShifted, 'darwin', {
        'tab.previousSameType': ['Mod+Shift+BracketLeft']
      })
    ).toBe(false)
    expect(
      keybindingMatchesAction('tab.nextSameType', jisRightBracketShifted, 'darwin', {
        'tab.nextSameType': ['Mod+Shift+BracketRight']
      })
    ).toBe(true)
    expect(
      keybindingMatchesAction('tab.nextSameType', jisLeftBracketShifted, 'darwin', {
        'tab.nextSameType': ['Mod+Shift+BracketRight']
      })
    ).toBe(false)

    expect(keybindingMatchesAction('terminal.focusPreviousPane', jisLeftBracket, 'darwin')).toBe(
      true
    )
    expect(keybindingMatchesAction('terminal.focusNextPane', jisLeftBracket, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('terminal.focusNextPane', jisRightBracket, 'darwin')).toBe(true)

    // Alt+bracket is the fresh-install same-type default after the convention swap.
    expect(
      keybindingMatchesAction('tab.previousSameType', { ...jisLeftBracket, alt: true }, 'darwin')
    ).toBe(true)
    expect(
      keybindingMatchesAction('tab.nextSameType', { ...jisRightBracket, alt: true }, 'darwin')
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.previousSameType',
        { ...jisLeftBracket, control: true, meta: false, alt: true },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.nextSameType',
        { ...jisLeftBracket, control: true, meta: false, alt: true },
        'linux'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'tab.nextSameType',
        { ...jisRightBracket, control: true, meta: false, alt: true },
        'linux'
      )
    ).toBe(true)

    expect(
      keybindingMatchesAction('terminal.splitRight', jisRightBracketShifted, 'darwin', {
        'terminal.splitRight': ['Mod+Shift+Backslash']
      })
    ).toBe(false)

    expect(
      keybindingMatchesAction(
        'tab.nextSameType',
        {
          key: 'Dead',
          code: 'BracketRight',
          control: false,
          meta: true,
          alt: false,
          shift: true
        },
        'darwin',
        { 'tab.nextSameType': ['Mod+Shift+BracketRight'] }
      )
    ).toBe(true)

    expect(
      keybindingMatchesAction(
        'tab.previousSameType',
        {
          key: '[',
          code: 'Digit8',
          control: true,
          meta: false,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'tab.previousSameType',
        {
          key: 'Dead',
          code: 'BracketLeft',
          control: true,
          meta: false,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toBe(true)
  })

  it('matches macOS Option-composed bracket shortcuts for same-type tab switching', () => {
    // Cmd+Alt+bracket is the fresh-install same-type default after the swap, so
    // Option-composed dead keys (\u2325[ -> "\u201c") must still resolve to that action.
    const macOptionLeftBracket = {
      key: '\u201c',
      code: 'BracketLeft',
      control: false,
      meta: true,
      alt: true,
      shift: false
    }
    const macOptionRightBracket = {
      key: '\u2018',
      code: 'BracketRight',
      control: false,
      meta: true,
      alt: true,
      shift: false
    }

    expect(keybindingMatchesAction('tab.previousSameType', macOptionLeftBracket, 'darwin')).toBe(
      true
    )
    expect(keybindingMatchesAction('tab.nextSameType', macOptionLeftBracket, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('tab.nextSameType', macOptionRightBracket, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('tab.previousSameType', macOptionRightBracket, 'darwin')).toBe(
      false
    )
  })
})
