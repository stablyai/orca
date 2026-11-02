import { afterEach, describe, expect, it } from 'vitest'
import { getKeybindingDefinition, type KeybindingDefinition } from '../../../../shared/keybindings'
import { i18n } from '@/i18n/i18n'
import { buildInterfaceSettingsSections } from '@/hooks/settings-navigation-interface-sections'
import type { SettingsNavigationBuildOptions } from '@/hooks/settings-navigation-build-options'
import { getShortcutsPaneTitleSearchEntry } from './shortcuts/shortcuts-search'
import { groupDefinitions } from './shortcuts/shortcut-groups'
import { buildShortcutRowVisibility } from './shortcuts/shortcut-row-visibility'
import { matchesSettingsSearch } from './search/settings-search'

const navigationOptions: SettingsNavigationBuildOptions = {
  isMac: false,
  isWindows: false,
  isLocalWindowsHost: false,
  isWindowsTerminalHost: false,
  isWebClient: false,
  hostQueuesMessages: false,
  typedChatPermissions: false,
  managedBrowserCreationEnabled: false,
  mobileEmulatorCreationEnabled: false,
  isDev: false,
  isLinearConnected: false,
  repos: []
}

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('localized Shortcuts search', () => {
  it('matches English aliases and a native pane title without dropping plugin rows', async () => {
    await i18n.changeLanguage('ko')

    const paneEntry = getShortcutsPaneTitleSearchEntry()
    const section = buildInterfaceSettingsSections(navigationOptions).find(
      (candidate) => candidate.id === 'shortcuts'
    )
    if (!section) {
      throw new Error('Missing Shortcuts navigation section')
    }
    expect(paneEntry.title).toBe('단축키')
    expect(section.title).toBe(paneEntry.title)
    expect(paneEntry.keywords).toContain('Shortcuts')
    expect(matchesSettingsSearch('hotkey', paneEntry)).toBe(true)
    expect(matchesSettingsSearch('keybinding', paneEntry)).toBe(true)
    expect(matchesSettingsSearch(paneEntry.title, paneEntry)).toBe(true)
    expect(matchesSettingsSearch('shortcuts', paneEntry)).toBe(true)

    const quickOpenDefinition = getKeybindingDefinition('worktree.quickOpen')
    if (!quickOpenDefinition) {
      throw new Error('Missing quick-open shortcut definition')
    }
    const pluginDefinition: KeybindingDefinition = {
      ...quickOpenDefinition,
      id: 'plugin:orca-samples.tasks/open',
      title: 'Open Tasks — Tasks',
      group: 'Plugins',
      searchKeywords: ['plugin-only']
    }
    const groups = groupDefinitions([], [pluginDefinition])
    const visibilityFor = (settingsSearchQuery: string) =>
      buildShortcutRowVisibility({
        groups,
        keybindings: {},
        conflictByAction: new Map(),
        terminalShortcutPolicy: 'orca-first',
        platform: 'darwin',
        managedBrowserCreationEnabled: false,
        mobileEmulatorCreationEnabled: false,
        agentDashboardEnabled: false,
        settingsSearchQuery,
        shortcutQuery: '',
        shortcutFilter: 'all'
      })

    for (const query of ['hotkey', 'keybinding', paneEntry.title]) {
      const result = visibilityFor(query)
      const visibleIds = result.visibleShortcutGroups.flatMap((group) =>
        group.rows.map(({ item }) => item.id)
      )
      expect(result.visibleShortcutCount).toBe(result.shortcutRows.length)
      expect(visibleIds).toContain('plugin:orca-samples.tasks/open')
    }
  })
})
