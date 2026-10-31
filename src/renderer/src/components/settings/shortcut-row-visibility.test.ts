import { describe, expect, it } from 'vitest'
import { getKeybindingDefinition } from '../../../../shared/keybindings'

import type { ShortcutGroup } from './shortcut-groups'
import { buildShortcutRowVisibility } from './shortcut-row-visibility'

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
})
