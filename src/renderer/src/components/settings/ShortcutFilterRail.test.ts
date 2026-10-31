import { describe, expect, it } from 'vitest'
import {
  SHORTCUT_LOCAL_SEARCH_QUERY_MAX_BYTES,
  isShortcutLocalSearchQueryTooLarge,
  matchesShortcutLocalSearch,
  normalizeShortcutLocalSearchQuery,
  type ShortcutRowModel
} from './ShortcutFilterRail'

describe('ShortcutFilterRail search helpers', () => {
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
