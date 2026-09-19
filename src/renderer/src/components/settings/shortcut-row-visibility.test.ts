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

function tilingGroup(): ShortcutGroup {
  const items = (['terminal.closePane', 'tiling.focusPaneByIndex'] as const).map((actionId) => {
    const definition = getKeybindingDefinition(actionId)
    if (!definition) {
      throw new Error(`Missing keybinding definition: ${actionId}`)
    }
    return definition
  })
  return { title: 'Terminal Panes', items }
}

const baseOptions = {
  keybindings: {},
  conflictByAction: new Map(),
  terminalShortcutPolicy: 'orca-first',
  platform: 'darwin',
  managedBrowserCreationEnabled: false,
  mobileEmulatorCreationEnabled: false,
  agentDashboardEnabled: false,
  tiledAgentsEnabled: false,
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
      tiledAgentsEnabled: false,
      settingsSearchQuery: '',
      shortcutQuery: '',
      shortcutFilter: 'all'
    })

    expect(result.shortcutRows.map((row) => row.item.id)).toEqual([
      'tab.newTerminal',
      'tab.newMarkdown'
    ])
  })

  it('hides the tiling rows while the tiled agents experiment is off', () => {
    const hidden = buildShortcutRowVisibility({ ...baseOptions, groups: [tilingGroup()] })

    expect(hidden.shortcutRows.map((row) => row.item.id)).toEqual(['terminal.closePane'])

    const shown = buildShortcutRowVisibility({
      ...baseOptions,
      groups: [tilingGroup()],
      tiledAgentsEnabled: true
    })

    expect(shown.shortcutRows.map((row) => row.item.id)).toEqual([
      'terminal.closePane',
      'tiling.focusPaneByIndex'
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
