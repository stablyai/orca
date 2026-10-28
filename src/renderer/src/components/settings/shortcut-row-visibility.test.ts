import { describe, expect, it } from 'vitest'
import { getKeybindingDefinition } from '../../../../shared/keybindings'

import type { ShortcutGroup } from './shortcut-groups'
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
