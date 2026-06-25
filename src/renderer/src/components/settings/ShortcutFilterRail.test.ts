import { describe, expect, it } from 'vitest'
import type { KeybindingActionId } from '../../../../shared/keybindings'
import {
  SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES,
  isShortcutLocalSearchQueryTooLarge,
  matchesShortcutLocalSearch,
  normalizeShortcutLocalSearchQuery,
  type ShortcutRowModel
} from './ShortcutFilterRail'

function createShortcutRow(): ShortcutRowModel {
  return {
    item: {
      id: 'settings.open' as KeybindingActionId,
      title: 'Open Settings',
      group: 'settings',
      scope: 'settings',
      searchKeywords: ['preferences', 'configuration'],
      defaultBindings: {
        darwin: ['Meta+,'],
        linux: ['Ctrl+,'],
        win32: ['Ctrl+,']
      }
    },
    groupTitle: 'Application',
    effective: ['Ctrl+,'],
    modified: false,
    warnings: []
  }
}

describe('ShortcutFilterRail search helpers', () => {
  it('normalizes bounded local shortcut searches', () => {
    expect(normalizeShortcutLocalSearchQuery('  Preferences  ')).toBe('preferences')
  })

  it('matches shortcut title, group, keywords, ids, and platform bindings', () => {
    const row = createShortcutRow()

    expect(matchesShortcutLocalSearch(row, 'settings', 'win32')).toBe(true)
    expect(matchesShortcutLocalSearch(row, 'application', 'win32')).toBe(true)
    expect(matchesShortcutLocalSearch(row, 'configuration', 'win32')).toBe(true)
    expect(matchesShortcutLocalSearch(row, 'ctrl+,', 'win32')).toBe(true)
    expect(matchesShortcutLocalSearch(row, 'terminal', 'win32')).toBe(false)
  })

  it('rejects queries that exceed the UTF-8 byte budget', () => {
    const query = 'é'.repeat(SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES)

    expect(query.length).toBe(SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES)
    expect(isShortcutLocalSearchQueryTooLarge(query)).toBe(true)
    expect(normalizeShortcutLocalSearchQuery(query)).toBeNull()
  })

  it('rejects oversized pasted shortcut searches before reading row metadata', () => {
    const oversizedQuery = 'secret-shortcut-search'.repeat(SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES)
    const row = {
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
    } as ShortcutRowModel

    expect(isShortcutLocalSearchQueryTooLarge(oversizedQuery)).toBe(true)
    expect(normalizeShortcutLocalSearchQuery(oversizedQuery)).toBeNull()
    expect(matchesShortcutLocalSearch(row, oversizedQuery, 'win32')).toBe(false)
  })
})
