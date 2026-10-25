// Override resolution and the conflict detector behind Settings → Shortcuts.
import { describe, expect, it } from 'vitest'
import {
  agentTabActionId,
  findKeybindingActionsForBinding,
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  KEYBINDING_DEFINITIONS
} from './keybindings'

describe('keybindings', () => {
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

  it('finds app-level owners of a prospective plugin chord with overrides', () => {
    expect(findKeybindingActionsForBinding('Mod+P', 'darwin')).toContain('worktree.quickOpen')
    expect(
      findKeybindingActionsForBinding('Mod+Alt+T', 'linux', {
        'view.tasks': ['Mod+Alt+T']
      })
    ).toContain('view.tasks')
    expect(findKeybindingActionsForBinding('Mod+F', 'darwin')).not.toContain('editor.find')
    // A German '+' key types Mod+Plus without Shift, the same chord as zoom.in's Mod+Shift+Plus.
    expect(findKeybindingActionsForBinding('Mod+Plus', 'linux')).toContain('zoom.in')
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

  it('flags the global send-review-notes command against editor chords it can shadow', () => {
    // Why: it fires from the global capture handler even while the editor is
    // focused, so Settings must warn when a user binds it over Add Review Note.
    expect(
      findKeybindingConflicts('darwin', { 'sourceControl.sendReviewNotes': ['Mod+Shift+A'] })
    ).toContainEqual(
      expect.objectContaining({
        binding: 'Mod+Shift+A',
        actionIds: expect.arrayContaining(['editor.addReviewNote', 'sourceControl.sendReviewNotes'])
      })
    )
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

  const findInterceptionConflicts = (
    platform: NodeJS.Platform,
    overrides?: Parameters<typeof findKeybindingConflicts>[1],
    options: Parameters<typeof findKeybindingConflicts>[2] = {}
  ) =>
    findKeybindingConflicts(platform, overrides, {
      ...options,
      includeMainProcessInterception: true
    })

  it('keeps main-process interception out of the loader and write conflict check', () => {
    expect(
      findKeybindingConflicts('darwin', { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] })
    ).toEqual([])
  })

  it('reports terminal bindings that lose their chord to main-process shortcuts', () => {
    expect(
      findInterceptionConflicts('darwin', { 'terminal.splitRight': ['Mod+Alt+ArrowRight'] })
    ).toContainEqual({
      binding: 'Mod+Alt+ArrowRight',
      actionIds: expect.arrayContaining(['worktree.history.forward', 'terminal.splitRight'])
    })
    expect(
      findInterceptionConflicts('darwin', { 'terminal.splitDown': ['Mod+Alt+ArrowLeft'] })
    ).toContainEqual({
      binding: 'Mod+Alt+ArrowLeft',
      actionIds: expect.arrayContaining(['worktree.history.back', 'terminal.splitDown'])
    })
    expect(
      findInterceptionConflicts('darwin', { 'terminal.splitRight': ['Mod+P'] })
    ).toContainEqual({
      binding: 'Mod+P',
      actionIds: expect.arrayContaining(['worktree.quickOpen', 'terminal.splitRight'])
    })
    expect(findInterceptionConflicts('linux', { 'terminal.splitRight': ['Alt+2'] })).toContainEqual(
      {
        binding: 'Alt+2',
        actionIds: expect.arrayContaining(['tab.selectByIndex', 'terminal.splitRight'])
      }
    )
  })

  it('reports main-process shortcuts against renderer actions in other scopes', () => {
    expect(
      findInterceptionConflicts('linux', {
        'workspace.create': ['Mod+Shift+N'],
        'tab.newTerminal': ['Mod+Shift+N']
      })
    ).toContainEqual({
      binding: 'Mod+Shift+N',
      actionIds: expect.arrayContaining(['workspace.create', 'tab.newTerminal'])
    })
  })

  it('still lets the two digit ranges share a modifier', () => {
    expect(
      findInterceptionConflicts('linux', {
        'workspace.selectByIndex': ['Alt+1'],
        'tab.selectByIndex': ['Alt+1']
      })
    ).toEqual([])
  })

  it('leaves the dictation chord to other scopes, since main lets it through while voice is off', () => {
    expect(findInterceptionConflicts('darwin', { 'terminal.splitRight': ['Mod+E'] })).toEqual([])
  })

  it('checks browser bindings only against main-process shortcuts a focused guest forwards first', () => {
    expect(
      findInterceptionConflicts('darwin', { 'browser.back': ['Mod+Alt+ArrowLeft'] })
    ).toContainEqual({
      binding: 'Mod+Alt+ArrowLeft',
      actionIds: expect.arrayContaining(['worktree.history.back', 'browser.back'])
    })
    expect(
      findInterceptionConflicts('darwin', {
        'browser.focusAddressBar': ['Mod+L'],
        'sidebar.right.toggle': ['Mod+L']
      })
    ).toEqual([])
  })

  it('keeps every default binding conflict-free on all platforms', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(
        findInterceptionConflicts(platform, undefined, {
          relevantActionIds: KEYBINDING_DEFINITIONS.map((definition) => definition.id)
        })
      ).toEqual([])
    }
  })
})
