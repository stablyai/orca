// Parser, capture, and formatting rules shared by every shortcut surface.
import { describe, expect, it } from 'vitest'
import {
  formatKeybindingList,
  isKeybindingActionId,
  keybindingFromInput,
  keybindingFromInputForAction,
  keybindingMatchesAction,
  normalizeKeybinding,
  normalizeKeybindingListForAction,
  normalizeKeybindingList
} from './keybindings'

describe('keybindings', () => {
  it('accepts bounded plugin command action IDs and rejects malformed variants', () => {
    expect(isKeybindingActionId('plugin:orca-samples.tasks/open')).toBe(true)
    expect(isKeybindingActionId('plugin:orca-samples.tasks/task.open-latest')).toBe(true)
    expect(isKeybindingActionId('plugin:tasks/open')).toBe(false)
    expect(isKeybindingActionId('plugin:orca-samples.tasks/../open')).toBe(false)
    expect(isKeybindingActionId(`plugin:orca-samples.tasks/${'a'.repeat(401)}`)).toBe(false)
  })

  it('normalizes editable shortcut input and rejects unsafe bindings', () => {
    expect(normalizeKeybinding(' ctrl + shift + p ')).toEqual({
      ok: true,
      value: 'Ctrl+Shift+P'
    })
    expect(normalizeKeybinding('shift+insert')).toEqual({ ok: true, value: 'Shift+Insert' })
    expect(normalizeKeybinding('cmdorctrl+p')).toEqual({ ok: true, value: 'Mod+P' })
    expect(normalizeKeybindingList('Ctrl+Shift+P, ctrl+shift+p, ⌘+k')).toEqual([
      'Ctrl+Shift+P',
      'Cmd+K'
    ])

    expect(normalizeKeybinding('Shift+P')).toMatchObject({ ok: false })
    expect(normalizeKeybinding('Mod+Ctrl+P')).toMatchObject({ ok: false })
    expect(normalizeKeybinding('Ctrl+Nope')).toMatchObject({ ok: false })
  })

  it('allows safe bare keys only for scoped actions that opt in', () => {
    expect(normalizeKeybinding('Delete')).toMatchObject({ ok: false })
    expect(normalizeKeybindingListForAction('fileExplorer.delete', 'Delete')).toEqual(['Delete'])
    expect(normalizeKeybindingListForAction('fileExplorer.delete', 'x')).toMatchObject({
      ok: false
    })
  })

  it('allows Shift-only chords only for native input-source switching', () => {
    const shiftSpace = {
      key: ' ',
      code: 'Space',
      control: false,
      meta: false,
      alt: false,
      shift: true
    }

    expect(keybindingFromInput(shiftSpace, 'darwin')).toMatchObject({ ok: false })
    expect(
      keybindingFromInputForAction('terminal.switchInputSource', shiftSpace, 'darwin')
    ).toEqual({ ok: true, value: 'Shift+Space' })
  })

  it('captures key events into canonical editable shortcuts', () => {
    expect(
      keybindingFromInput(
        { key: 'j', code: 'KeyJ', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Mod+J' })
    expect(
      keybindingFromInput(
        { key: 'J', code: 'KeyJ', control: true, meta: false, alt: true, shift: true },
        'linux'
      )
    ).toEqual({ ok: true, value: 'Mod+Alt+Shift+J' })
    expect(
      keybindingFromInput({ key: 'Control', code: 'ControlLeft', control: true }, 'linux')
    ).toEqual({ ok: false, error: 'Press a key, not only a modifier.' })
  })

  it('captures macOS Option-composed key events via the physical code', () => {
    expect(
      keybindingFromInput(
        { key: 'ç', code: 'KeyC', meta: true, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Mod+Alt+C' })
    expect(
      keybindingFromInput(
        { key: '“', code: 'BracketLeft', meta: true, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Mod+Alt+BracketLeft' })
    expect(
      keybindingFromInput(
        { key: 'Alt', code: 'AltLeft', meta: false, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toEqual({ ok: false, error: 'Press a key, not only a modifier.' })
    expect(
      keybindingFromInput(
        { key: '¡', code: 'Digit1', meta: true, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toEqual({ ok: false, error: 'Press a key, not only a modifier.' })
  })

  it('applies per-action bare-key rules while capturing shortcuts', () => {
    const deleteEvent = {
      key: 'Delete',
      code: 'Delete',
      control: false,
      meta: false,
      alt: false,
      shift: false
    }

    expect(keybindingFromInput(deleteEvent, 'linux')).toMatchObject({ ok: false })
    expect(keybindingFromInputForAction('fileExplorer.delete', deleteEvent, 'linux')).toEqual({
      ok: true,
      value: 'Delete'
    })
  })

  it('binds F7 / Shift+F7 for diff-change navigation and matches their events', () => {
    // Opt-in actions accept bare / Shift-only function keys...
    expect(normalizeKeybindingListForAction('editor.nextChange', 'F7')).toEqual(['F7'])
    expect(normalizeKeybindingListForAction('editor.previousChange', 'Shift+F7')).toEqual([
      'Shift+F7'
    ])
    // ...but they stay unsafe for actions that do not opt in.
    expect(normalizeKeybinding('F7')).toMatchObject({ ok: false })
    expect(normalizeKeybinding('Shift+F7')).toMatchObject({ ok: false })

    const f7 = { key: 'F7', code: 'F7', control: false, meta: false, alt: false, shift: false }
    const shiftF7 = { ...f7, shift: true }
    expect(keybindingMatchesAction('editor.nextChange', f7, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('editor.nextChange', shiftF7, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('editor.previousChange', shiftF7, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('editor.previousChange', f7, 'darwin')).toBe(false)
  })

  it('formats keybindings with platform labels', () => {
    expect(formatKeybindingList(['Mod+Shift+J'], 'darwin')).toBe('⌘⇧J')
    expect(formatKeybindingList(['Mod+Shift+J'], 'linux')).toBe('Ctrl+Shift+J')
    expect(formatKeybindingList([], 'win32')).toBe('Unassigned')
  })

  it('preserves explicit numpad shortcut tokens', () => {
    const numpadAdd = {
      key: '+',
      code: 'NumpadAdd',
      control: false,
      meta: true,
      alt: false,
      shift: false
    }

    expect(keybindingFromInput(numpadAdd, 'darwin')).toEqual({
      ok: true,
      value: 'Mod+NumpadAdd'
    })
    expect(keybindingMatchesAction('zoom.in', numpadAdd, 'darwin')).toBe(true)
    expect(
      keybindingMatchesAction(
        'zoom.out',
        {
          ...numpadAdd,
          key: '-',
          code: 'NumpadSubtract'
        },
        'darwin'
      )
    ).toBe(true)
  })
})
