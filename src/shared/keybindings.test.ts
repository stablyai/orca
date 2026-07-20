/* eslint-disable max-lines -- Why: shared keybinding tests cover the central
 * registry, parser, matcher, and conflict detector together so shortcut
 * semantics cannot drift across app surfaces. */
import { describe, expect, it } from 'vitest'
import {
  agentTabActionId,
  getKeybindingDefinition,
  findKeybindingConflicts,
  formatKeybinding,
  formatKeybindingList,
  getEffectiveKeybindingsForAction,
  isDigitIndexActionId,
  isDoubleTapBinding,
  keybindingFromInput,
  LEGACY_TAB_SWITCH_BINDINGS,
  keybindingFromInputForAction,
  keybindingMatchesAction,
  keybindingMatchesInput,
  matchKeybindingDigitIndex,
  normalizeKeybinding,
  normalizeKeybindingArrayForAction,
  normalizeKeybindingListForAction,
  normalizeKeybindingList
} from './keybindings'
import type { KeybindingActionId, KeybindingPlatform } from './keybindings'
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

  it('parses, normalizes, and rejects double-tap modifier bindings', () => {
    expect(normalizeKeybinding('DoubleTap+Shift')).toEqual({ ok: true, value: 'DoubleTap+Shift' })
    expect(normalizeKeybinding(' doubletap + shift ')).toEqual({
      ok: true,
      value: 'DoubleTap+Shift'
    })
    expect(normalizeKeybinding('DoubleTap+Mod')).toEqual({ ok: true, value: 'DoubleTap+Mod' })
    expect(normalizeKeybinding('DoubleTap+Cmd')).toEqual({ ok: true, value: 'DoubleTap+Cmd' })
    expect(normalizeKeybinding('DoubleTap+Alt')).toEqual({ ok: true, value: 'DoubleTap+Alt' })
    expect(normalizeKeybinding('DoubleTap+Ctrl')).toEqual({ ok: true, value: 'DoubleTap+Ctrl' })

    // A key after DoubleTap is invalid.
    expect(normalizeKeybinding('DoubleTap+Shift+P')).toMatchObject({ ok: false })
    // Two modifiers is invalid.
    expect(normalizeKeybinding('DoubleTap+Shift+Alt')).toMatchObject({ ok: false })
    // Mod + platform-specific reuses the shared error.
    expect(normalizeKeybinding('DoubleTap+Mod+Cmd')).toEqual({
      ok: false,
      error: 'Use either Mod or a platform-specific modifier, not both.'
    })
    // Bare DoubleTap is invalid.
    expect(normalizeKeybinding('DoubleTap')).toMatchObject({ ok: false })

    expect(isDoubleTapBinding('DoubleTap+Shift')).toBe(true)
    expect(isDoubleTapBinding('Mod+P')).toBe(false)
    expect(isDoubleTapBinding('not-a-binding')).toBe(false)
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

  it('defines a default shortcut for opening markdown notes', () => {
    expect(getEffectiveKeybindingsForAction('tab.openMarkdown', 'darwin')).toEqual(['Mod+Shift+O'])
    expect(formatKeybindingList(['Mod+Shift+O'], 'darwin')).toBe('⌘⇧O')
  })

  it('defines a default shortcut for adding an editor review note', () => {
    expect(getEffectiveKeybindingsForAction('editor.addReviewNote', 'darwin')).toEqual([
      'Mod+Shift+A'
    ])
    expect(getEffectiveKeybindingsForAction('editor.addReviewNote', 'linux')).toEqual([
      'Mod+Shift+A'
    ])
    expect(getEffectiveKeybindingsForAction('editor.addReviewNote', 'win32')).toEqual([
      'Mod+Shift+A'
    ])
    expect(formatKeybindingList(['Mod+Shift+A'], 'darwin')).toBe('⌘⇧A')
    expect(formatKeybindingList(['Mod+Shift+A'], 'linux')).toBe('Ctrl+Shift+A')

    const macChord = {
      key: 'a',
      code: 'KeyA',
      meta: true,
      control: false,
      alt: false,
      shift: true
    }
    const ctrlChord = { ...macChord, meta: false, control: true }
    expect(keybindingMatchesAction('editor.addReviewNote', macChord, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('editor.addReviewNote', ctrlChord, 'linux')).toBe(true)
    expect(keybindingMatchesAction('editor.addReviewNote', ctrlChord, 'win32')).toBe(true)

    const oldCtrlAltChord = {
      key: 'n',
      code: 'KeyN',
      meta: false,
      control: true,
      alt: true,
      shift: false
    }
    expect(keybindingMatchesAction('editor.addReviewNote', oldCtrlAltChord, 'linux')).toBe(false)
    expect(keybindingMatchesAction('editor.addReviewNote', oldCtrlAltChord, 'win32')).toBe(false)
  })

  it('defines platform-native replace-in-editor shortcuts', () => {
    expect(getEffectiveKeybindingsForAction('editor.replace', 'darwin')).toEqual(['Mod+Alt+F'])
    expect(getEffectiveKeybindingsForAction('editor.replace', 'linux')).toEqual(['Mod+H'])
    expect(getEffectiveKeybindingsForAction('editor.replace', 'win32')).toEqual(['Mod+H'])
    expect(formatKeybindingList(['Mod+Alt+F'], 'darwin')).toBe('⌘⌥F')
    expect(formatKeybindingList(['Mod+H'], 'linux')).toBe('Ctrl+H')
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

  it('keeps zoom reset on Mod+0 and focuses worktree list on a distinct chord', () => {
    // Why: both actions previously defaulted to Mod+0, so main-process zoom
    // reset always won and Focus worktree list was unreachable (#8584).
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(getEffectiveKeybindingsForAction('zoom.reset', platform)).toEqual(['Mod+0'])
      expect(getEffectiveKeybindingsForAction('sidebar.focusWorktreeList', platform)).toEqual([
        'Mod+Shift+0'
      ])
    }

    const zoomResetInput = {
      key: '0',
      code: 'Digit0',
      meta: true,
      control: false,
      alt: false,
      shift: false
    }
    const focusListInput = { ...zoomResetInput, shift: true }

    expect(keybindingMatchesAction('zoom.reset', zoomResetInput, 'darwin')).toBe(true)
    expect(keybindingMatchesAction('sidebar.focusWorktreeList', zoomResetInput, 'darwin')).toBe(
      false
    )
    expect(keybindingMatchesAction('sidebar.focusWorktreeList', focusListInput, 'darwin')).toBe(
      true
    )
    expect(keybindingMatchesAction('zoom.reset', focusListInput, 'darwin')).toBe(false)

    expect(
      findKeybindingConflicts('darwin', { 'sidebar.focusWorktreeList': ['Mod+0'] })
    ).toContainEqual({
      binding: 'Mod+0',
      actionIds: expect.arrayContaining(['zoom.reset', 'sidebar.focusWorktreeList'])
    })
  })

  it('reports quick-command menu conflicts with global shortcuts and digit ranges', () => {
    expect(
      findKeybindingConflicts('darwin', {
        'tab.openQuickCommandsMenu': ['Mod+P']
      })
    ).toContainEqual({
      binding: 'Mod+P',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'tab.openQuickCommandsMenu'])
    })

    expect(
      findKeybindingConflicts('darwin', {
        'tab.openQuickCommandsMenu': ['Cmd+P']
      })
    ).toContainEqual({
      binding: 'Mod+P',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'tab.openQuickCommandsMenu'])
    })

    expect(
      findKeybindingConflicts('linux', {
        'tab.openQuickCommandsMenu': ['Ctrl+P']
      })
    ).toContainEqual({
      binding: 'Mod+P',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'tab.openQuickCommandsMenu'])
    })

    expect(
      findKeybindingConflicts('darwin', {
        'tab.openQuickCommandsMenu': ['Mod+3']
      })
    ).toContainEqual({
      binding: 'Mod+3',
      actionIds: expect.arrayContaining(['workspace.selectByIndex', 'tab.openQuickCommandsMenu'])
    })

    expect(
      findKeybindingConflicts('darwin', {
        'tab.openQuickCommandsMenu': ['Cmd+3']
      })
    ).toContainEqual({
      binding: 'Cmd+3',
      actionIds: expect.arrayContaining(['workspace.selectByIndex', 'tab.openQuickCommandsMenu'])
    })

    expect(
      findKeybindingConflicts('linux', {
        'tab.openQuickCommandsMenu': ['Ctrl+3']
      })
    ).toContainEqual({
      binding: 'Ctrl+3',
      actionIds: expect.arrayContaining(['workspace.selectByIndex', 'tab.openQuickCommandsMenu'])
    })

    expect(
      findKeybindingConflicts('linux', {
        'tab.openQuickCommandsMenu': ['Alt+4']
      })
    ).toContainEqual({
      binding: 'Alt+4',
      actionIds: expect.arrayContaining(['tab.selectByIndex', 'tab.openQuickCommandsMenu'])
    })
  })

  it('defines macOS-only rename shortcuts that stay conflict-free', () => {
    expect(getEffectiveKeybindingsForAction('tab.rename', 'darwin')).toEqual(['Mod+R'])
    expect(getEffectiveKeybindingsForAction('tab.rename', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.rename', 'win32')).toEqual([])
    expect(getEffectiveKeybindingsForAction('workspace.rename', 'darwin')).toEqual(['Mod+Alt+R'])
    expect(getEffectiveKeybindingsForAction('workspace.rename', 'linux')).toEqual([])
    expect(formatKeybindingList(['Mod+Alt+R'], 'darwin')).toBe('⌘⌥R')
    expect(getKeybindingDefinition('tab.rename')?.searchKeywords).not.toContain('set title')
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
        'darwin',
        undefined,
        { context: 'terminal', terminalShortcutPolicy: 'terminal-first' }
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

  it('defaults tab-switch chords to the swapped convention for fresh installs', () => {
    // New users get the widespread mapping: Shift+bracket cycles all tabs,
    // Alt+bracket cycles within the active type.
    expect(getEffectiveKeybindingsForAction('tab.nextAllTypes', 'darwin')).toEqual([
      'Mod+Shift+BracketRight'
    ])
    expect(getEffectiveKeybindingsForAction('tab.previousAllTypes', 'darwin')).toEqual([
      'Mod+Shift+BracketLeft'
    ])
    expect(getEffectiveKeybindingsForAction('tab.nextSameType', 'darwin')).toEqual([
      'Mod+Alt+BracketRight'
    ])
    expect(getEffectiveKeybindingsForAction('tab.previousSameType', 'darwin')).toEqual([
      'Mod+Alt+BracketLeft'
    ])
  })

  it('pins the pre-swap chords via LEGACY_TAB_SWITCH_BINDINGS for upgrading installs', () => {
    // These are what the seed migration writes so pre-existing users keep the
    // shortcuts they learned; overriding an action with its legacy value must
    // reproduce the old effective binding.
    expect(LEGACY_TAB_SWITCH_BINDINGS).toEqual({
      'tab.nextSameType': ['Mod+Shift+BracketRight'],
      'tab.previousSameType': ['Mod+Shift+BracketLeft'],
      'tab.nextAllTypes': ['Mod+Alt+BracketRight'],
      'tab.previousAllTypes': ['Mod+Alt+BracketLeft']
    })
    for (const [actionId, bindings] of Object.entries(LEGACY_TAB_SWITCH_BINDINGS)) {
      expect(
        getEffectiveKeybindingsForAction(actionId as KeybindingActionId, 'darwin', {
          [actionId]: bindings
        })
      ).toEqual(bindings)
    }
  })

  it('defines browser history shortcuts for Logitech side-button remaps', () => {
    expect(getEffectiveKeybindingsForAction('browser.back', 'darwin')).toEqual(['Mod+BracketLeft'])
    expect(getEffectiveKeybindingsForAction('browser.forward', 'darwin')).toEqual([
      'Mod+BracketRight'
    ])
    expect(getEffectiveKeybindingsForAction('browser.back', 'linux')).toEqual(['Alt+ArrowLeft'])
    expect(getEffectiveKeybindingsForAction('browser.forward', 'win32')).toEqual(['Alt+ArrowRight'])
    expect(
      keybindingMatchesAction(
        'browser.back',
        {
          key: '[',
          code: 'BracketLeft',
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
        'browser.forward',
        {
          key: 'ArrowRight',
          code: 'ArrowRight',
          meta: false,
          control: false,
          alt: true,
          shift: false
        },
        'linux'
      )
    ).toBe(true)
  })

  it('binds close-all editor tabs to Mod+Alt+W beside tab.close', () => {
    expect(getEffectiveKeybindingsForAction('tab.closeAll', 'darwin')).toEqual(['Mod+Alt+W'])
    expect(getEffectiveKeybindingsForAction('tab.closeAll', 'linux')).toEqual(['Mod+Alt+W'])
    expect(getEffectiveKeybindingsForAction('tab.closeAll', 'win32')).toEqual(['Mod+Alt+W'])
    expect(formatKeybindingList(['Mod+Alt+W'], 'darwin')).toBe('⌘⌥W')
    expect(formatKeybindingList(['Mod+Alt+W'], 'linux')).toBe('Ctrl+Alt+W')

    // Why: macOS Option+W composes to a glyph (∑), so the chord must resolve
    // through the physical-code fallback rather than the logical key.
    const macComposedCloseAll = {
      key: '∑',
      code: 'KeyW',
      meta: true,
      control: false,
      alt: true,
      shift: false
    }
    expect(keybindingMatchesAction('tab.closeAll', macComposedCloseAll, 'darwin')).toBe(true)
    const linuxCloseAll = {
      key: 'w',
      code: 'KeyW',
      meta: false,
      control: true,
      alt: true,
      shift: false
    }
    expect(keybindingMatchesAction('tab.closeAll', linuxCloseAll, 'linux')).toBe(true)
    expect(
      keybindingMatchesAction('tab.closeAll', linuxCloseAll, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'orca-first'
      })
    ).toBe(true)
    // Why: close-all is a workspace tab command, so terminal-first mode should
    // keep passing the chord through to shells and TUIs.
    expect(
      keybindingMatchesAction('tab.closeAll', linuxCloseAll, 'linux', undefined, {
        context: 'terminal',
        terminalShortcutPolicy: 'terminal-first'
      })
    ).toBe(false)

    // Why: Mod+Alt+W and Mod+W are neighbors; the extra Alt must keep the two
    // actions from firing on each other's chord.
    const macCloseActive = {
      key: 'w',
      code: 'KeyW',
      meta: true,
      control: false,
      alt: false,
      shift: false
    }
    expect(keybindingMatchesAction('tab.close', macComposedCloseAll, 'darwin')).toBe(false)
    expect(keybindingMatchesAction('tab.closeAll', macCloseActive, 'darwin')).toBe(false)

    // Stays in the Tabs group/scope so Settings → Shortcuts lists it for rebinding.
    const definition = getKeybindingDefinition('tab.closeAll')
    expect(definition?.group).toBe('Tabs')
    expect(definition?.scope).toBe('tabs')

    // Why: both live in the Tabs scope, so rebinding closeAll onto Mod+W must
    // surface as a conflict with tab.close in Settings.
    expect(findKeybindingConflicts('darwin', { 'tab.closeAll': ['Mod+W'] })).toContainEqual({
      binding: 'Mod+W',
      actionIds: expect.arrayContaining(['tab.close', 'tab.closeAll'])
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

  it('names terminal title shortcuts after pane menu actions', () => {
    const setTitle = getKeybindingDefinition('terminal.setTitle')
    const clearTitle = getKeybindingDefinition('terminal.clearPaneTitle')

    expect(setTitle?.title).toBe('Set Title…')
    expect(setTitle?.group).toBe('Terminal Panes')
    expect(setTitle?.scope).toBe('terminal')
    expect(setTitle?.searchKeywords).toContain('set title')
    expect(getEffectiveKeybindingsForAction('terminal.setTitle', 'darwin')).toEqual([])
    expect(getEffectiveKeybindingsForAction('terminal.setTitle', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('terminal.setTitle', 'win32')).toEqual([])

    expect(clearTitle?.title).toBe('Clear Pane Title')
    expect(clearTitle?.group).toBe('Terminal Panes')
    expect(clearTitle?.scope).toBe('terminal')
    expect(clearTitle?.searchKeywords).toContain('remove title')
    expect(getEffectiveKeybindingsForAction('terminal.clearPaneTitle', 'darwin')).toEqual([])
    expect(getEffectiveKeybindingsForAction('terminal.clearPaneTitle', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('terminal.clearPaneTitle', 'win32')).toEqual([])
    expect(
      keybindingMatchesAction(
        'terminal.clearPaneTitle',
        { key: 't', code: 'KeyT', control: false, meta: true, alt: true, shift: false },
        'darwin',
        { 'terminal.clearPaneTitle': ['Mod+Alt+T'] }
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

  it('keeps workspace board unassigned until users customize it', () => {
    const binding = {
      key: 'k',
      code: 'KeyK',
      control: true,
      meta: false,
      alt: true,
      shift: false
    }

    expect(getEffectiveKeybindingsForAction('workspace.openBoard', 'linux')).toEqual([])
    expect(keybindingMatchesAction('workspace.openBoard', binding, 'linux')).toBe(false)
    expect(
      keybindingMatchesAction('workspace.openBoard', binding, 'linux', {
        'workspace.openBoard': ['Mod+Alt+K']
      })
    ).toBe(true)

    const definition = getKeybindingDefinition('workspace.openBoard')
    expect(definition?.title).toBe('Open Workspace Board')
    expect(definition?.searchKeywords).toEqual(
      expect.arrayContaining(['workspace', 'board', 'kanban'])
    )
  })

  it('keeps the quick commands menu toggle unassigned until users customize it', () => {
    const platforms: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']

    for (const platform of platforms) {
      expect(getEffectiveKeybindingsForAction('tab.openQuickCommandsMenu', platform)).toEqual([])
    }

    const binding = {
      key: 'q',
      code: 'KeyQ',
      control: true,
      meta: false,
      alt: false,
      shift: true
    }

    expect(keybindingMatchesAction('tab.openQuickCommandsMenu', binding, 'linux')).toBe(false)
    expect(
      keybindingMatchesAction('tab.openQuickCommandsMenu', binding, 'linux', {
        'tab.openQuickCommandsMenu': ['Mod+Shift+Q']
      })
    ).toBe(true)

    const definition = getKeybindingDefinition('tab.openQuickCommandsMenu')
    expect(definition?.title).toBe('Toggle Quick Commands menu')
    expect(definition?.group).toBe('Quick Commands')
    expect(definition?.scope).toBe('tabs')
    expect(definition?.searchKeywords).toEqual(
      expect.arrayContaining(['shortcut', 'quick', 'command', 'menu', 'tab'])
    )
  })

  it('keeps the sleeping-workspaces toggle unassigned until users customize it', () => {
    const binding = {
      key: 's',
      code: 'KeyS',
      control: true,
      meta: false,
      alt: true,
      shift: false
    }

    // Ships unbound on every platform (issue #5209): assign-it-yourself.
    expect(getEffectiveKeybindingsForAction('sidebar.sleepingWorkspaces.toggle', 'darwin')).toEqual(
      []
    )
    expect(getEffectiveKeybindingsForAction('sidebar.sleepingWorkspaces.toggle', 'linux')).toEqual(
      []
    )
    expect(getEffectiveKeybindingsForAction('sidebar.sleepingWorkspaces.toggle', 'win32')).toEqual(
      []
    )
    expect(keybindingMatchesAction('sidebar.sleepingWorkspaces.toggle', binding, 'linux')).toBe(
      false
    )
    expect(
      keybindingMatchesAction('sidebar.sleepingWorkspaces.toggle', binding, 'linux', {
        'sidebar.sleepingWorkspaces.toggle': ['Mod+Alt+S']
      })
    ).toBe(true)

    const definition = getKeybindingDefinition('sidebar.sleepingWorkspaces.toggle')
    expect(definition?.title).toBe('Toggle Sleeping Workspaces')
    expect(definition?.searchKeywords).toEqual(
      expect.arrayContaining(['sleeping', 'workspaces', 'filter'])
    )
  })

  it('defines floating workspace panel action metadata', () => {
    const actionIds = [
      'floatingWorkspace.maximize' as KeybindingActionId,
      'floatingWorkspace.minimize' as KeybindingActionId
    ] as const

    for (const actionId of actionIds) {
      expect(getKeybindingDefinition(actionId), actionId).toMatchObject({ id: actionId })
    }
  })

  it('assigns the floating workspace maximize default only on macOS', () => {
    const maximizeAction = 'floatingWorkspace.maximize' as KeybindingActionId

    expect(getEffectiveKeybindingsForAction(maximizeAction, 'darwin')).toEqual(['Mod+Alt+Shift+A'])
    expect(getEffectiveKeybindingsForAction(maximizeAction, 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction(maximizeAction, 'win32')).toEqual([])
  })

  it('captures and round-trips the macOS Option-composed maximize chord', () => {
    const maximizeAction = 'floatingWorkspace.maximize' as KeybindingActionId

    // Why: macOS Option+A composes to a glyph (å), so capture must resolve the
    // chord through the physical-code fallback rather than the composed key,
    // matching the matcher so a user override round-trips to the same binding.
    const macComposedMaximize = {
      key: 'å',
      code: 'KeyA',
      meta: true,
      control: false,
      alt: true,
      shift: true
    }
    expect(keybindingFromInput(macComposedMaximize, 'darwin')).toEqual({
      ok: true,
      value: 'Mod+Alt+Shift+A'
    })
    expect(keybindingMatchesAction(maximizeAction, macComposedMaximize, 'darwin')).toBe(true)
    // The captured override formats back to the same effective shortcut.
    expect(
      getEffectiveKeybindingsForAction(maximizeAction, 'darwin', {
        [maximizeAction]: ['Mod+Alt+Shift+A']
      })
    ).toEqual(['Mod+Alt+Shift+A'])
    expect(formatKeybindingList(['Mod+Alt+Shift+A'], 'darwin')).toBe('⌘⌥⇧A')
  })

  it('leaves floating workspace minimize unassigned because floating terminal toggle owns show and hide', () => {
    const platforms: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']
    const minimizeAction = 'floatingWorkspace.minimize' as KeybindingActionId

    for (const platform of platforms) {
      expect(getEffectiveKeybindingsForAction(minimizeAction, platform)).toEqual([])
    }
    expect(getEffectiveKeybindingsForAction('floatingTerminal.toggle', 'darwin')).toEqual([
      'Mod+Alt+A'
    ])
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

  // Why: #8533 — both previously defaulted to Mod+Shift+E on darwin; emulator won.
  it('keeps explorer on Mod+Shift+E and gives the mobile emulator a non-colliding macOS default', () => {
    expect(getEffectiveKeybindingsForAction('sidebar.explorer.toggle', 'darwin')).toEqual([
      'Mod+Shift+E'
    ])
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'darwin')).toEqual([
      'Mod+Alt+Shift+E'
    ])
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'linux')).toEqual([])
    expect(getEffectiveKeybindingsForAction('tab.newSimulator', 'win32')).toEqual([])
    expect(formatKeybindingList(['Mod+Alt+Shift+E'], 'darwin')).toBe('⌘⌥⇧E')

    expect(
      keybindingMatchesAction(
        'sidebar.explorer.toggle',
        { key: 'e', code: 'KeyE', meta: true, control: false, alt: false, shift: true },
        'darwin'
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction(
        'tab.newSimulator',
        { key: 'e', code: 'KeyE', meta: true, control: false, alt: false, shift: true },
        'darwin'
      )
    ).toBe(false)
    expect(
      keybindingMatchesAction(
        'tab.newSimulator',
        { key: 'e', code: 'KeyE', meta: true, control: false, alt: true, shift: true },
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
      actionIds: expect.arrayContaining(['sidebar.explorer.toggle', 'worktree.palette'])
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

  it('keeps floating workspace tab shortcuts active in app focus even with terminal-first policy configured', () => {
    const panelFocus = {
      context: 'app',
      terminalShortcutPolicy: 'terminal-first'
    } as const

    expect(
      keybindingMatchesAction(
        'tab.rename',
        { key: 'r', code: 'KeyR', meta: true, control: false, alt: false, shift: false },
        'darwin',
        undefined,
        panelFocus
      )
    ).toBe(true)
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        { key: '4', code: 'Digit4', meta: false, control: false, alt: true, shift: false },
        'linux',
        undefined,
        panelFocus
      )
    ).toBe(3)
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

  it('matches double-tap bindings only against synthetic double-tap input', () => {
    expect(
      keybindingMatchesInput('DoubleTap+Shift', { doubleTapModifier: 'Shift' }, 'darwin')
    ).toBe(true)
    // Mod resolves per platform: meta on macOS, control elsewhere.
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Cmd' }, 'darwin')).toBe(
      true
    )
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Ctrl' }, 'win32')).toBe(
      true
    )
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Cmd' }, 'win32')).toBe(
      false
    )
    expect(keybindingMatchesInput('DoubleTap+Mod', { doubleTapModifier: 'Ctrl' }, 'darwin')).toBe(
      false
    )
    expect(keybindingMatchesInput('DoubleTap+Shift', { doubleTapModifier: 'Alt' }, 'darwin')).toBe(
      false
    )

    // Cross-type negatives: a double-tap binding never matches a normal keydown,
    // and a normal binding never matches a synthetic double-tap input.
    expect(
      keybindingMatchesInput('DoubleTap+Shift', { key: 'A', code: 'KeyA', shift: true }, 'darwin')
    ).toBe(false)
    expect(keybindingMatchesInput('Mod+P', { doubleTapModifier: 'Cmd' }, 'darwin')).toBe(false)

    // Action-level matching works through user overrides, for free.
    expect(
      keybindingMatchesAction('worktree.quickOpen', { doubleTapModifier: 'Shift' }, 'darwin', {
        'worktree.quickOpen': ['DoubleTap+Shift']
      })
    ).toBe(true)
    expect(
      keybindingMatchesAction('worktree.quickOpen', { doubleTapModifier: 'Alt' }, 'darwin', {
        'worktree.quickOpen': ['DoubleTap+Shift']
      })
    ).toBe(false)
  })

  it('captures double-tap gestures into canonical bindings', () => {
    expect(keybindingFromInput({ doubleTapModifier: 'Shift' }, 'darwin')).toEqual({
      ok: true,
      value: 'DoubleTap+Shift'
    })
    // The platform primary modifier canonicalizes to Mod, matching normal capture.
    expect(keybindingFromInput({ doubleTapModifier: 'Cmd' }, 'darwin')).toEqual({
      ok: true,
      value: 'DoubleTap+Mod'
    })
    expect(keybindingFromInput({ doubleTapModifier: 'Ctrl' }, 'win32')).toEqual({
      ok: true,
      value: 'DoubleTap+Mod'
    })
    // A non-primary modifier keeps its explicit token.
    expect(keybindingFromInput({ doubleTapModifier: 'Ctrl' }, 'darwin')).toEqual({
      ok: true,
      value: 'DoubleTap+Ctrl'
    })
    expect(keybindingFromInput({ doubleTapModifier: 'Alt' }, 'linux')).toEqual({
      ok: true,
      value: 'DoubleTap+Alt'
    })
    // Ctrl is the primary modifier on Linux too, so it canonicalizes to Mod.
    expect(keybindingFromInput({ doubleTapModifier: 'Ctrl' }, 'linux')).toEqual({
      ok: true,
      value: 'DoubleTap+Mod'
    })
    // Cmd is not the primary modifier off-mac, so it stays explicit.
    expect(keybindingFromInput({ doubleTapModifier: 'Cmd' }, 'linux')).toEqual({
      ok: true,
      value: 'DoubleTap+Cmd'
    })
  })

  it('formats double-tap bindings as the modifier glyph twice', () => {
    expect(formatKeybinding('DoubleTap+Shift', 'darwin')).toEqual(['⇧', '⇧'])
    expect(formatKeybinding('DoubleTap+Shift', 'linux')).toEqual(['Shift', 'Shift'])
    expect(formatKeybinding('DoubleTap+Mod', 'darwin')).toEqual(['⌘', '⌘'])
    expect(formatKeybinding('DoubleTap+Mod', 'win32')).toEqual(['Ctrl', 'Ctrl'])
    expect(formatKeybinding('DoubleTap+Cmd', 'win32')).toEqual(['Cmd', 'Cmd'])
    expect(formatKeybinding('DoubleTap+Alt', 'darwin')).toEqual(['⌥', '⌥'])
    // Ctrl's glyph ⌃ diverges from Mod's ⌘ on Mac, so cover it explicitly.
    expect(formatKeybinding('DoubleTap+Ctrl', 'darwin')).toEqual(['⌃', '⌃'])
    expect(formatKeybindingList(['DoubleTap+Shift'], 'darwin')).toBe('⇧ ⇧')
    expect(formatKeybindingList(['DoubleTap+Shift'], 'linux')).toBe('Shift Shift')
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

  it('reports conflicts across two double-tap bindings', () => {
    // Both actions share the same DoubleTap+Shift binding via overrides, so both
    // are in customizedActions and the conflict detector must flag them.
    const conflicts = findKeybindingConflicts('darwin', {
      'worktree.quickOpen': ['DoubleTap+Shift'],
      'view.tasks': ['DoubleTap+Shift']
    })
    expect(conflicts).toContainEqual({
      binding: 'DoubleTap+Shift',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'view.tasks'])
    })
  })

  it('reports conflicts across platform-primary double-tap aliases', () => {
    expect(
      findKeybindingConflicts('darwin', {
        'worktree.quickOpen': ['DoubleTap+Mod'],
        'view.tasks': ['DoubleTap+Cmd']
      })
    ).toContainEqual({
      binding: 'DoubleTap+Mod',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'view.tasks'])
    })

    expect(
      findKeybindingConflicts('linux', {
        'worktree.quickOpen': ['DoubleTap+Mod'],
        'view.tasks': ['DoubleTap+Ctrl']
      })
    ).toContainEqual({
      binding: 'DoubleTap+Mod',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'view.tasks'])
    })
  })

  it('does not report a conflict when one action lists double-tap aliases for itself', () => {
    expect(
      findKeybindingConflicts('darwin', {
        'worktree.quickOpen': ['DoubleTap+Mod', 'DoubleTap+Cmd']
      })
    ).toEqual([])
    expect(
      findKeybindingConflicts('linux', {
        'worktree.quickOpen': ['DoubleTap+Mod', 'DoubleTap+Ctrl']
      })
    ).toEqual([])
  })
})

describe('digit-index shortcuts', () => {
  const digitInput = (
    digit: string,
    modifiers: { meta?: boolean; control?: boolean; alt?: boolean; shift?: boolean }
  ): Parameters<typeof matchKeybindingDigitIndex>[1] => ({
    key: digit,
    code: `Digit${digit}`,
    meta: Boolean(modifiers.meta),
    control: Boolean(modifiers.control),
    alt: Boolean(modifiers.alt),
    shift: Boolean(modifiers.shift)
  })

  it('flags the two ranged actions as digit-index rows', () => {
    expect(isDigitIndexActionId('tab.selectByIndex')).toBe(true)
    expect(isDigitIndexActionId('workspace.selectByIndex')).toBe(true)
    expect(isDigitIndexActionId('tab.newTerminal')).toBe(false)
  })

  it('resolves the default ranges per platform', () => {
    // macOS: workspace = Cmd+1-9, tab = Ctrl+1-9.
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('3', { meta: true }),
        'darwin'
      )
    ).toBe(2)
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('3', { meta: true }), 'darwin')
    ).toBeNull()
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('3', { control: true }), 'darwin')
    ).toBe(2)

    // Windows/Linux: workspace = Ctrl+1-9, tab = Alt+1-9.
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('4', { control: true }),
        'linux'
      )
    ).toBe(3)
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('4', { alt: true }), 'linux')
    ).toBe(3)
  })

  it('ignores non-range presses and extra modifiers', () => {
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('3', { meta: true, shift: true }),
        'darwin'
      )
    ).toBeNull()
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        { key: 'p', code: 'KeyP', meta: false, control: true, alt: false, shift: false },
        'darwin'
      )
    ).toBeNull()
  })

  it('honors custom bindings, including swapping tab and workspace modifiers', () => {
    const swapped = {
      'tab.selectByIndex': ['Mod+1'],
      'workspace.selectByIndex': ['Ctrl+1']
    }
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        digitInput('5', { meta: true }),
        'darwin',
        swapped
      )
    ).toBe(4)
    expect(
      matchKeybindingDigitIndex(
        'workspace.selectByIndex',
        digitInput('5', { control: true }),
        'darwin',
        swapped
      )
    ).toBe(4)
    // A disabled (empty) override never fires.
    expect(
      matchKeybindingDigitIndex('tab.selectByIndex', digitInput('5', { control: true }), 'darwin', {
        'tab.selectByIndex': []
      })
    ).toBeNull()
  })

  it('respects the terminal-first context gate', () => {
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        digitInput('2', { control: true }),
        'darwin',
        undefined,
        {
          context: 'terminal',
          terminalShortcutPolicy: 'terminal-first'
        }
      )
    ).toBeNull()
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        digitInput('2', { control: true }),
        'darwin',
        undefined,
        {
          context: 'terminal',
          terminalShortcutPolicy: 'orca-first'
        }
      )
    ).toBe(1)
  })

  it('canonicalizes a captured chord to the digit-1 representative', () => {
    expect(
      keybindingFromInputForAction(
        'workspace.selectByIndex',
        digitInput('7', { meta: true }),
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Mod+1' })
    expect(
      keybindingFromInputForAction(
        'tab.selectByIndex',
        digitInput('9', { control: true }),
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Ctrl+1' })
    // A non-number chord is rejected with guidance.
    expect(
      keybindingFromInputForAction(
        'tab.selectByIndex',
        { key: 'p', code: 'KeyP', meta: true, control: false, alt: false, shift: false },
        'darwin'
      )
    ).toMatchObject({ ok: false })
  })

  it('allows extra modifiers (e.g. Shift) on a digit-index chord', () => {
    expect(
      keybindingFromInputForAction(
        'tab.selectByIndex',
        digitInput('5', { control: true, shift: true }),
        'darwin'
      )
    ).toEqual({ ok: true, value: 'Ctrl+Shift+1' })
    expect(normalizeKeybindingListForAction('workspace.selectByIndex', 'Mod+Shift+5')).toEqual([
      'Mod+Shift+1'
    ])
  })

  it('matches via the physical-code fallback when the key value is unavailable', () => {
    // macOS/IME edge cases can leave key empty while code carries the digit.
    expect(
      matchKeybindingDigitIndex(
        'tab.selectByIndex',
        { key: '', code: 'Digit5', meta: false, control: true, alt: false, shift: false },
        'darwin'
      )
    ).toBe(4)
  })

  it('canonicalizes stored bindings and rejects non-number chords', () => {
    expect(normalizeKeybindingListForAction('workspace.selectByIndex', 'Mod+5')).toEqual(['Mod+1'])
    expect(normalizeKeybindingArrayForAction('tab.selectByIndex', ['Ctrl+9'])).toEqual(['Ctrl+1'])
    expect(normalizeKeybindingListForAction('tab.selectByIndex', 'Mod+P')).toMatchObject({
      ok: false
    })
  })

  it('lets the two ranges swap modifiers without a false conflict', () => {
    // The headline use case: tab → Cmd, workspace → Ctrl. They live in
    // different scopes, so neither edit is blocked as a conflict.
    expect(
      findKeybindingConflicts('darwin', {
        'tab.selectByIndex': ['Mod+1'],
        'workspace.selectByIndex': ['Ctrl+1']
      })
    ).toEqual([])
  })
})
