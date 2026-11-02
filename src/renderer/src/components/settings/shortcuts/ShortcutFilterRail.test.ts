import { afterEach, describe, expect, it } from 'vitest'
import {
  getKeybindingDefinition,
  type KeybindingActionId,
  type KeybindingDefinition
} from '../../../../../shared/keybindings'
import type { KeybindingOverrides } from '../../../../../shared/keybindings/types'
import { i18n } from '@/i18n/i18n'
import type { ShortcutGroup } from './shortcut-groups'
import { getShortcutsPaneTitleSearchEntry } from './shortcuts-search'
import { buildShortcutRowVisibility } from './shortcut-row-visibility'
import {
  SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES,
  isShortcutLocalSearchQueryTooLarge,
  matchesShortcutLocalSearch,
  normalizeShortcutLocalSearchQuery,
  type ShortcutFilter,
  type ShortcutRowModel
} from './ShortcutFilterRail'

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('ShortcutFilterRail search helpers', () => {
  it('rejects oversized pasted shortcut searches before reading row metadata', () => {
    const oversizedQuery = 'secret-shortcut-search'.repeat(SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES)
    const row: ShortcutRowModel = {
      get item(): ShortcutRowModel['item'] {
        throw new Error('oversized shortcut searches must not scan shortcut metadata')
      },
      get groupTitle(): string {
        throw new Error('oversized shortcut searches must not scan shortcut groups')
      },
      get effective(): readonly string[] {
        throw new Error('oversized shortcut searches must not format keybindings')
      },
      modified: false,
      warnings: []
    }

    expect(isShortcutLocalSearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(normalizeShortcutLocalSearchQuery(oversizedQuery)).toBeNull()
    expect(matchesShortcutLocalSearch(row, oversizedQuery, 'win32')).toBe(false)
  })

  it('filters partial pane-title matches while preserving aliases and the no-match fallback', async () => {
    await i18n.changeLanguage('ko')
    const quickOpen = getKeybindingDefinition('worktree.quickOpen')
    if (!quickOpen) {
      throw new Error('Missing quick-open shortcut definition')
    }
    const cutDefinition: KeybindingDefinition = {
      ...quickOpen,
      title: 'Cut',
      group: 'Editing',
      searchKeywords: []
    }
    const pluginDefinition: KeybindingDefinition = {
      ...quickOpen,
      id: 'plugin:orca-samples.tasks/open',
      title: 'Open Tasks — Tasks',
      group: 'Plugins',
      searchKeywords: ['plugin-only']
    }
    const groups: ShortcutGroup[] = [
      { title: 'Editing', items: [cutDefinition] },
      { title: 'Plugins', items: [pluginDefinition] }
    ]
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
    const visibleIdsFor = (query: string) =>
      visibilityFor(query).visibleShortcutGroups.flatMap((group) =>
        group.rows.map((row) => row.item.id)
      )

    const partialTitleVisibleIds = visibleIdsFor('cut')
    expect(partialTitleVisibleIds).toContain('worktree.quickOpen')
    expect(partialTitleVisibleIds).not.toContain('plugin:orca-samples.tasks/open')

    const paneTitle = getShortcutsPaneTitleSearchEntry()
    for (const alias of [
      'hotkey',
      '  HOTKEY  ',
      'keybinding',
      '  KEYMAP  ',
      'Shortcuts',
      paneTitle.title
    ]) {
      expect(visibleIdsFor(alias), alias).toContain('plugin:orca-samples.tasks/open')
    }

    expect(visibleIdsFor('unrelated-query')).toEqual([
      'worktree.quickOpen',
      'plugin:orca-samples.tasks/open'
    ])
  })

  it('keeps local search, status filters, and disabled actions scoped under a pane alias', () => {
    const quickOpen = getKeybindingDefinition('worktree.quickOpen')
    const historyBack = getKeybindingDefinition('worktree.history.back')
    const dashboardToggle = getKeybindingDefinition('dashboard.toggle')
    if (!quickOpen || !historyBack || !dashboardToggle) {
      throw new Error('Missing shortcut definitions needed for visibility coverage')
    }

    const pluginDefinition: KeybindingDefinition = {
      ...quickOpen,
      id: 'plugin:orca-samples.tasks/open',
      title: 'Open Tasks',
      group: 'Plugins',
      searchKeywords: ['plugin-only']
    }
    const groups: ShortcutGroup[] = [
      { title: 'General', items: [quickOpen, historyBack, dashboardToggle, pluginDefinition] }
    ]
    const keybindings: KeybindingOverrides = {
      'worktree.quickOpen': ['Mod+K'],
      'worktree.history.back': []
    }
    const conflictByAction = new Map<KeybindingActionId, string[]>([
      [pluginDefinition.id, ['duplicate binding']]
    ])
    const visibilityFor = (shortcutFilter: ShortcutFilter, shortcutQuery = '') =>
      buildShortcutRowVisibility({
        groups,
        keybindings,
        conflictByAction,
        terminalShortcutPolicy: 'orca-first',
        platform: 'darwin',
        managedBrowserCreationEnabled: false,
        mobileEmulatorCreationEnabled: false,
        agentDashboardEnabled: false,
        settingsSearchQuery: 'hotkey',
        shortcutQuery,
        shortcutFilter
      })
    const visibleIdsFor = (shortcutFilter: ShortcutFilter, shortcutQuery = '') =>
      visibilityFor(shortcutFilter, shortcutQuery).visibleShortcutGroups.flatMap((group) =>
        group.rows.map((row) => row.item.id)
      )

    const allRows = visibilityFor('all')
    expect(allRows.shortcutRows.map((row) => row.item.id)).not.toContain('dashboard.toggle')
    expect(allRows.filterCounts).toEqual({ all: 3, modified: 2, unassigned: 1, conflicts: 1 })
    expect(visibleIdsFor('modified')).toEqual(['worktree.quickOpen', 'worktree.history.back'])
    expect(visibleIdsFor('unassigned')).toEqual(['worktree.history.back'])
    expect(visibleIdsFor('conflicts')).toEqual(['plugin:orca-samples.tasks/open'])
    expect(visibleIdsFor('all', 'go to file')).toEqual(['worktree.quickOpen'])
  })
})
