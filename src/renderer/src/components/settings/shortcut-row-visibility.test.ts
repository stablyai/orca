import { describe, expect, it } from 'vitest'
import { getKeybindingDefinition } from '../../../../shared/keybindings'
import type { ShortcutGroup } from './shortcut-groups'
import { buildShortcutRowVisibility } from './shortcut-row-visibility'

function creationGroup(): ShortcutGroup {
  const items = (
    ['tab.newTerminal', 'tab.newBrowser', 'tab.newMarkdown', 'tab.newSimulator'] as const
  ).map((actionId) => {
    const definition = getKeybindingDefinition(actionId)
    if (!definition) {
      throw new Error(`Missing keybinding definition: ${actionId}`)
    }
    return definition
  })
  return { title: 'Tabs', items }
}

function globalGroup(): ShortcutGroup {
  const items = (['workspace.openBoard', 'dashboard.toggle'] as const).map((actionId) => {
    const definition = getKeybindingDefinition(actionId)
    if (!definition) {
      throw new Error(`Missing keybinding definition: ${actionId}`)
    }
    return definition
  })
  return { title: 'Global', items }
}

const baseOptions = {
  keybindings: {},
  conflictByAction: new Map(),
  terminalShortcutPolicy: 'orca-first',
  platform: 'darwin',
  managedBrowserCreationEnabled: false,
  mobileEmulatorCreationEnabled: false,
  agentDashboardEnabled: false,
  settingsSearchQuery: '',
  shortcutQuery: '',
  shortcutFilter: 'all'
} as const

describe('buildShortcutRowVisibility', () => {
  it('hides client-impossible creation shortcuts without hiding terminal or markdown', () => {
    const result = buildShortcutRowVisibility({
      groups: [creationGroup()],
      keybindings: {},
      conflictByAction: new Map(),
      terminalShortcutPolicy: 'orca-first',
      platform: 'darwin',
      managedBrowserCreationEnabled: false,
      mobileEmulatorCreationEnabled: false,
      agentDashboardEnabled: false,
      settingsSearchQuery: '',
      shortcutQuery: '',
      shortcutFilter: 'all'
    })

    expect(result.shortcutRows.map((row) => row.item.id)).toEqual([
      'tab.newTerminal',
      'tab.newMarkdown'
    ])
  })

  it('hides the agent dashboard toggle while its experiment is off', () => {
    const hidden = buildShortcutRowVisibility({ ...baseOptions, groups: [globalGroup()] })

    expect(hidden.shortcutRows.map((row) => row.item.id)).toEqual(['workspace.openBoard'])

    const shown = buildShortcutRowVisibility({
      ...baseOptions,
      groups: [globalGroup()],
      agentDashboardEnabled: true
    })

    expect(shown.shortcutRows.map((row) => row.item.id)).toEqual([
      'workspace.openBoard',
      'dashboard.toggle'
    ])
  })
})

describe('buildShortcutRowVisibility editor status', () => {
  function quickOpenGroup(): ShortcutGroup {
    const definition = getKeybindingDefinition('worktree.quickOpen')
    if (!definition) {
      throw new Error('Missing keybinding definition: worktree.quickOpen')
    }
    return { title: 'Global', items: [definition] }
  }

  it('flags rows the Emacs preset takes over only while the preset is on', () => {
    const groups = [quickOpenGroup()]
    const off = buildShortcutRowVisibility({ ...baseOptions, groups, platform: 'linux' })
    expect(off.shortcutRows[0]?.editorStatus).toBeUndefined()

    const emacsOnLinux = buildShortcutRowVisibility({
      ...baseOptions,
      groups,
      platform: 'linux',
      editorKeybindings: 'emacs'
    })
    expect(emacsOnLinux.shortcutRows[0]?.editorStatus?.label).toBe('Emacs editor')

    // Cmd+P on macOS is not an Emacs chord, so the badge stays off there.
    const emacsOnMac = buildShortcutRowVisibility({
      ...baseOptions,
      groups,
      editorKeybindings: 'emacs'
    })
    expect(emacsOnMac.shortcutRows[0]?.editorStatus).toBeUndefined()

    const vim = buildShortcutRowVisibility({
      ...baseOptions,
      groups,
      platform: 'linux',
      editorKeybindings: 'vim'
    })
    expect(vim.shortcutRows[0]?.editorStatus).toBeUndefined()
  })
})
