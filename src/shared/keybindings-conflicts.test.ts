// Override resolution and the conflict detector behind Settings → Shortcuts.
import { describe, expect, it } from 'vitest'
import {
  agentTabActionId,
  findKeybindingActionsForBinding,
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction
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
})
