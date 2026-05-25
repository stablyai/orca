/* eslint-disable max-lines -- Why: shared keybinding tests cover the central
 * registry, parser, matcher, and conflict detector together so shortcut
 * semantics cannot drift across app surfaces. */
import { describe, expect, it } from 'vitest'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  keybindingFromInput,
  keybindingFromInputForAction,
  keybindingMatchesAction,
  normalizeKeybinding,
  normalizeKeybindingListForAction,
  normalizeKeybindingList
} from './keybindings'

describe('keybindings', () => {
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

  it('formats keybindings with platform labels', () => {
    expect(formatKeybindingList(['Mod+Shift+J'], 'darwin')).toBe('⌘⇧J')
    expect(formatKeybindingList(['Mod+Shift+J'], 'linux')).toBe('Ctrl+Shift+J')
    expect(formatKeybindingList([], 'win32')).toBe('Unassigned')
  })

  it('uses overrides as the complete effective binding list for an action', () => {
    const overrides = {
      'worktree.quickOpen': ['Ctrl+Alt+O', 'not-a-shortcut']
    }

    expect(getEffectiveKeybindingsForAction('worktree.quickOpen', 'linux', overrides)).toEqual([
      'Ctrl+Alt+O'
    ])
    expect(
      keybindingMatchesAction(
        'worktree.quickOpen',
        { key: 'o', code: 'KeyO', control: true, meta: false, alt: true, shift: false },
        'linux',
        overrides
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'worktree.quickOpen',
        { key: 'p', code: 'KeyP', control: true, meta: false, alt: false, shift: false },
        'linux',
        overrides
      )
    ).toBe(false)
  })

  it('reports conflicts across default and customized actions', () => {
    expect(findKeybindingConflicts('linux')).toEqual([])

    const conflicts = findKeybindingConflicts('linux', { 'view.tasks': ['Mod+P'] })

    expect(conflicts).toContainEqual({
      binding: 'Mod+P',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'view.tasks'])
    })
  })

  it('keeps equalize pane sizes unassigned until users customize it', () => {
    expect(getEffectiveKeybindingsForAction('terminal.equalizePaneSizes', 'darwin')).toEqual([])
    expect(
      keybindingMatchesAction(
        'terminal.equalizePaneSizes',
        { key: '=', code: 'Equal', control: false, meta: true, alt: false, shift: false },
        'darwin'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'terminal.equalizePaneSizes',
        { key: '=', code: 'Equal', control: false, meta: true, alt: false, shift: false },
        'darwin',
        { 'terminal.equalizePaneSizes': ['Mod+Equal'] }
      )
    ).toBe(true)
  })

  it('reports customized renderer conflicts with native menu accelerators', () => {
    expect(findKeybindingConflicts('darwin')).toEqual([])

    const conflicts = findKeybindingConflicts('darwin', {
      'worktree.palette': ['Mod+Shift+E']
    })

    expect(conflicts).toContainEqual({
      binding: 'Mod+Shift+E',
      actionIds: expect.arrayContaining([
        'file.exportPdf',
        'sidebar.explorer.toggle',
        'worktree.palette'
      ])
    })
  })

  it('keeps Orca-first terminal context backward compatible', () => {
    const ctrlP = {
      key: 'p',
      code: 'KeyP',
      control: true,
      meta: false,
      alt: false,
      shift: false
    }

    expect(keybindingMatchesAction('worktree.quickOpen', ctrlP, 'linux')).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', ctrlP, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', ctrlP, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'terminal.search',
        { key: 'f', code: 'KeyF', control: true, meta: false, alt: false, shift: false },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
  })

  it('keeps terminal-allowed app shortcuts active in terminal-first mode', () => {
    expect(
      keybindingMatchesAction(
        'floatingTerminal.toggle',
        { key: 'a', code: 'KeyA', control: true, meta: false, alt: true, shift: false },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.previousRecent',
        { key: 'Tab', code: 'Tab', control: true, meta: false, alt: false, shift: false },
        'linux',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'worktree.palette',
        { key: 'j', code: 'KeyJ', control: false, meta: true, alt: false, shift: false },
        'darwin',
        undefined,
        { context: 'app', terminalShortcutPolicy: 'terminal-first' }
      )
    ).toBe(true)
  })

  it('keeps the existing terminal paste defaults on Windows and Linux', () => {
    expect(getEffectiveKeybindingsForAction('terminal.paste', 'darwin')).toEqual(['Mod+V'])
    expect(getEffectiveKeybindingsForAction('terminal.paste', 'linux')).toEqual([
      'Ctrl+V',
      'Ctrl+Shift+V',
      'Shift+Insert'
    ])
    expect(
      keybindingMatchesAction(
        'terminal.paste',
        { key: 'v', code: 'KeyV', control: true, meta: false, alt: false, shift: false },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'terminal.paste',
        { key: 'Insert', code: 'Insert', control: false, meta: false, alt: false, shift: true },
        'linux'
      )
    ).toBe(true)
  })

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

    expect(
      keybindingMatchesAction('tab.previousAllTypes', { ...jisLeftBracket, alt: true }, 'darwin')
    ).toBe(true)
    expect(
      keybindingMatchesAction('tab.nextAllTypes', { ...jisRightBracket, alt: true }, 'darwin')
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.previousAllTypes',
        { ...jisLeftBracket, control: true, meta: false, alt: true },
        'linux'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.nextAllTypes',
        { ...jisLeftBracket, control: true, meta: false, alt: true },
        'linux'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'tab.nextAllTypes',
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
        'tab.previousAllTypes',
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
        'tab.previousAllTypes',
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
})
