/* eslint-disable max-lines -- Why: shared keybinding tests cover the central
 * registry, parser, matcher, and conflict detector together so shortcut
 * semantics cannot drift across app surfaces. */
import { describe, expect, it } from 'vitest'
import {
  agentTabActionId,
  getKeybindingDefinition,
  findKeybindingConflicts,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  keybindingFromInput,
  keybindingFromInputForAction,
  keybindingMatchesAction,
  keybindingMatchesInput,
  normalizeKeybinding,
  normalizeKeybindingListForAction,
  normalizeKeybindingList
} from './keybindings'
import { ALL_TUI_AGENTS } from './tui-agent-display-names'

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

  it('defines a default shortcut for opening markdown notes', () => {
    expect(getEffectiveKeybindingsForAction('tab.openMarkdown', 'darwin')).toEqual(['Mod+Shift+O'])
    expect(formatKeybindingList(['Mod+Shift+O'], 'darwin')).toBe('⌘⇧O')
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

  it('defines macOS-only rename shortcuts that stay conflict-free', () => {
    expect(getEffectiveKeybindingsForAction('tab.rename', 'darwin')).toEqual(['Mod+R'])
    expect(getEffectiveKeybindingsForAction('tab.rename', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.rename', 'win32')).toEqual([])
    expect(getEffectiveKeybindingsForAction('workspace.rename', 'darwin')).toEqual(['Mod+Alt+R'])
    expect(getEffectiveKeybindingsForAction('workspace.rename', 'linux')).toEqual([])
    expect(formatKeybindingList(['Mod+Alt+R'], 'darwin')).toBe('⌘⌥R')
    expect(
      keybindingMatchesAction(
        'tab.rename',
        {
          key: 'r',
          code: 'KeyR',
          meta: true,
          control: false,
          alt: false,
          shift: false
        },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.rename',
        {
          key: 'r',
          code: 'KeyR',
          meta: false,
          control: true,
          alt: false,
          shift: false
        },
        'linux'
      )
    ).toBe(false)

    // Why: tab.rename (Mod+R) intentionally shares its binding with
    // browser.reload, but the two live in different scopes (tabs vs browser),
    // so customizing tab.rename to its default must not flag a conflict.
    expect(findKeybindingConflicts('darwin', { 'tab.rename': ['Mod+R'] })).toEqual([])
    // Why: tab/workspace rename share the same active workspace keydown path,
    // so Settings must reject user overrides that make one shadow the other.
    expect(findKeybindingConflicts('darwin', { 'workspace.rename': ['Mod+R'] })).toEqual([
      {
        binding: 'Mod+R',
        actionIds: ['workspace.rename', 'tab.rename']
      }
    ])
    expect(findKeybindingConflicts('darwin', { 'tab.rename': ['Mod+Alt+R'] })).toEqual([
      {
        binding: 'Mod+Alt+R',
        actionIds: ['workspace.rename', 'tab.rename']
      }
    ])
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

  it('keeps workspace delete unassigned until users customize it', () => {
    const binding = {
      key: 'Backspace',
      code: 'Backspace',
      control: true,
      meta: false,
      alt: false,
      shift: true
    }

    expect(getEffectiveKeybindingsForAction('workspace.delete', 'linux')).toEqual([])
    expect(keybindingMatchesAction('workspace.delete', binding, 'linux')).toBe(false)
    expect(
      keybindingMatchesAction('workspace.delete', binding, 'linux', {
        'workspace.delete': ['Mod+Shift+Backspace']
      })
    ).toBe(true)
  })

  it('defines a macOS-only default for the new agent tab shortcut', () => {
    expect(getEffectiveKeybindingsForAction('tab.newAgent', 'darwin')).toEqual(['Mod+Alt+T'])
    expect(getEffectiveKeybindingsForAction('tab.newAgent', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.newAgent', 'win32')).toEqual([])
    expect(
      keybindingMatchesAction(
        'tab.newAgent',
        { key: 't', code: 'KeyT', meta: true, control: false, alt: true, shift: false },
        'darwin'
      )
    ).toBe(true)
  })

  it('defines an unassigned per-agent tab action for every TUI agent', () => {
    for (const agent of ALL_TUI_AGENTS) {
      const actionId = agentTabActionId(agent)
      const definition = getKeybindingDefinition(actionId)
      expect(definition, actionId).toBeDefined()
      expect(definition?.group).toBe('Agents')
      expect(definition?.scope).toBe('tabs')
      expect(getEffectiveKeybindingsForAction(actionId, 'darwin')).toEqual([])
    }
  })

  it('matches per-agent tab actions only through user overrides', () => {
    const binding = { key: 'k', code: 'KeyK', meta: true, control: false, alt: true, shift: true }
    expect(keybindingMatchesAction(agentTabActionId('claude'), binding, 'darwin')).toBe(false)
    expect(
      keybindingMatchesAction(agentTabActionId('claude'), binding, 'darwin', {
        'tab.newAgent.claude': ['Mod+Alt+Shift+K']
      })
    ).toBe(true)
  })

  it('ignores selected actions when checking shortcut conflicts', () => {
    expect(
      findKeybindingConflicts(
        'darwin',
        {
          'tab.newAgent.claude': ['Mod+Alt+Shift+K'],
          'tab.newAgent.codex': ['Mod+Alt+Shift+K']
        },
        { ignoredActionIds: [agentTabActionId('claude')] }
      )
    ).toEqual([])
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
    const deleteBinding = {
      key: 'Backspace',
      code: 'Backspace',
      control: true,
      meta: false,
      alt: false,
      shift: true
    }

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
        'workspace.delete',
        deleteBinding,
        'linux',
        { 'workspace.delete': ['Mod+Shift+Backspace'] },
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

  it('matches macOS Option-composed bracket shortcuts for all-type tab switching', () => {
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

    expect(keybindingMatchesAction('tab.previousAllTypes', macOptionLeftBracket, 'darwin')).toBe(
      true
    )
    expect(keybindingMatchesAction('tab.nextAllTypes', macOptionLeftBracket, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('tab.nextAllTypes', macOptionRightBracket, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('tab.previousAllTypes', macOptionRightBracket, 'darwin')).toBe(
      false
    )
  })
})
