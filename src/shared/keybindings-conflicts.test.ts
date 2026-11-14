import { describe, expect, it } from 'vitest'
import {
  findKeybindingActionsForBinding,
  findKeybindingConflicts,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction,
  resolveKeybindingOverrides,
  getLegacySearchBindings
} from './keybindings'

describe('keybindings', () => {
  it('keeps the inherited search chord available for terminal-first chat toggling', () => {
    const overrides = resolveKeybindingOverrides('win32', {}, getLegacySearchBindings('win32'))
    const ctrlShiftJ = { key: 'j', control: true, shift: true }
    const terminalFirst = { context: 'terminal', terminalShortcutPolicy: 'terminal-first' } as const
    expect(
      keybindingMatchesAction(
        'terminal.toggleNativeChat',
        ctrlShiftJ,
        'win32',
        overrides,
        terminalFirst
      )
    ).toBe(true)
    expect(
      keybindingMatchesAction('worktree.palette', ctrlShiftJ, 'win32', overrides, terminalFirst)
    ).toBe(false)
    expect(
      findKeybindingConflicts('win32', overrides, { includeMainProcessInterception: true })
    ).toEqual([])
    expect(
      keybindingMatchesAction(
        'terminal.toggleNativeChat',
        ctrlShiftJ,
        'win32',
        {
          ...overrides,
          'worktree.navigateDown': ['Ctrl+Shift+J']
        },
        terminalFirst
      )
    ).toBe(false)
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
    // Global capture runs inside editors too; warn when it shadows Add Review Note.
    expect(
      findKeybindingConflicts('darwin', { 'sourceControl.sendReviewNotes': ['Mod+Shift+A'] })
    ).toContainEqual(
      expect.objectContaining({
        binding: 'Mod+Shift+A',
        actionIds: expect.arrayContaining(['editor.addReviewNote', 'sourceControl.sendReviewNotes'])
      })
    )
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

  it("keeps the chat toggle's own default alias inside an override", () => {
    const toggle = 'terminal.toggleNativeChat'
    const overrides = { [toggle]: ['Mod+Alt+K', 'Mod+Shift+J'] }
    for (const find of [findKeybindingConflicts, findInterceptionConflicts]) {
      expect(
        find('win32', overrides).filter(({ actionIds }) => actionIds.includes(toggle))
      ).toEqual([])
      expect(
        find('win32', { ...overrides, 'worktree.navigateDown': ['Mod+Shift+J'] })
      ).toContainEqual({
        binding: 'Mod+Shift+J',
        actionIds: expect.arrayContaining([toggle, 'worktree.navigateDown'])
      })
    }
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
})
