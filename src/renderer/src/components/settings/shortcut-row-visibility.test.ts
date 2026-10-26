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
  it('shows a suppressed implicit toggle as unassigned without a modified/reset obligation', () => {
    const item = getKeybindingDefinition('terminal.toggleNativeChat')
    if (!item) {
      throw new Error('Missing toggle definition')
    }
    const result = buildShortcutRowVisibility({
      ...baseOptions,
      groups: [{ title: 'Chat', items: [item] }],
      keybindings: { 'worktree.navigateDown': ['Mod+Shift+J'] }
    })
    expect(result.shortcutRows[0]).toMatchObject({ effective: [], modified: false })
    expect(result.filterCounts.modified).toBe(0)
    expect(result.filterCounts.unassigned).toBe(1)
  })

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
