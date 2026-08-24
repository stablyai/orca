// Actions that ship unbound until a user assigns them.
import { describe, expect, it } from 'vitest'
import {
  getKeybindingDefinition,
  getEffectiveKeybindingsForAction,
  keybindingMatchesAction
} from './keybindings'
import type { KeybindingActionId, KeybindingPlatform } from './keybindings'

describe('keybindings', () => {
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
    expect(definition?.title).toBe('Toggle Workspace Board')
    expect(definition?.searchKeywords).toEqual(
      expect.arrayContaining(['workspace', 'board', 'kanban', 'toggle', 'open', 'close'])
    )
  })

  it('keeps the agent dashboard toggle unassigned until users customize it', () => {
    const platforms: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']

    for (const platform of platforms) {
      expect(getEffectiveKeybindingsForAction('dashboard.toggle', platform)).toEqual([])
    }

    const binding = {
      key: 'd',
      code: 'KeyD',
      control: true,
      meta: false,
      alt: true,
      shift: false
    }

    expect(keybindingMatchesAction('dashboard.toggle', binding, 'linux')).toBe(false)
    expect(
      keybindingMatchesAction('dashboard.toggle', binding, 'linux', {
        'dashboard.toggle': ['Mod+Alt+D']
      })
    ).toBe(true)

    const definition = getKeybindingDefinition('dashboard.toggle')
    expect(definition?.title).toBe('Toggle Agent Dashboard')
    expect(definition?.group).toBe('Global')
    expect(definition?.allowInTerminal).toBe(true)
    expect(definition?.searchKeywords).toEqual(
      expect.arrayContaining(['agent', 'dashboard', 'kanban', 'toggle', 'open', 'close'])
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
})
