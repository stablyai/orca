import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getKeybindingDefinition } from '../../../../shared/keybindings'
import { i18n } from '@/i18n/i18n'
import {
  getShortcutSearchEntry,
  matchesShortcutLocalSearch,
  normalizeShortcutLocalSearchQuery,
  type ShortcutRowModel
} from './ShortcutFilterRail'
import { matchesSettingsSearch } from './settings-search'
import { getShortcutsPaneSearchEntries } from './shortcuts-search'

describe('Turkish shortcut search', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('tr')
  })

  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  const browserForwardRow = (): ShortcutRowModel => {
    const item = getKeybindingDefinition('browser.forward')
    if (!item) {
      throw new Error('Missing browser.forward definition')
    }
    return {
      item,
      groupTitle: item.group,
      effective: [],
      modified: false,
      warnings: []
    }
  }

  it.each(['ileri', 'İLERİ', 'tarayıcı', 'TARAYICI'])('finds localized titles for %s', (query) => {
    const normalized = normalizeShortcutLocalSearchQuery(query)
    expect(normalized).not.toBeNull()
    expect(matchesShortcutLocalSearch(browserForwardRow(), normalized ?? '', 'win32')).toBe(true)
    expect(matchesSettingsSearch(query, getShortcutSearchEntry(browserForwardRow()))).toBe(true)
  })

  it('preserves English command searches in both search surfaces', () => {
    const row = browserForwardRow()
    expect(matchesShortcutLocalSearch(row, 'go forward in browser', 'win32')).toBe(true)
    expect(matchesSettingsSearch('go forward in browser', getShortcutSearchEntry(row))).toBe(true)
    expect(matchesSettingsSearch('go forward in browser', getShortcutsPaneSearchEntries())).toBe(
      true
    )
  })

  it('indexes translated commands for the Settings sidebar', () => {
    expect(matchesSettingsSearch('dosyaya git', getShortcutsPaneSearchEntries())).toBe(true)
    expect(matchesSettingsSearch('ileri', getShortcutsPaneSearchEntries())).toBe(true)
  })

  it('preserves case-insensitive English keywords containing I', () => {
    expect(matchesSettingsSearch('input', { title: 'Other', keywords: ['INPUT'] })).toBe(true)
    expect(matchesSettingsSearch('INPUT', { title: 'Other', keywords: ['input'] })).toBe(true)
  })
})
