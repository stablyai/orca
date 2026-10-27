import { describe, expect, it } from 'vitest'
import { getKeybindingDefinition } from '../../../../shared/keybindings'

import { buildShortcutRowVisibility } from './shortcut-row-visibility'

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
})
