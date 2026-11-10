import type { MatchRange } from '../../../../../shared/palette-match/normalized-text'
import type { SettingsNavSection } from './settings-navigation-types'
import {
  getSettingsSectionSearchEntries,
  normalizeSettingsSearchQuery,
  rankSettingsSearchItems,
  type SettingsSearchEntry
} from '../search/settings-search'
import { getSettingsTitleTargetId } from '../section-layout/settings-target-highlight'

export type SettingsSearchResultOpenMode = 'preview' | 'pick'

export type SettingsSearchResult = {
  key: string
  section: SettingsNavSection
  entry: SettingsSearchEntry
  isPane: boolean
  /** Scroll target inside the pane; the pane id itself means "show from the top". */
  targetId: string
}

export function buildSettingsSearchResults(
  sections: readonly SettingsNavSection[],
  resolveAnchorId: (section: SettingsNavSection, entry: SettingsSearchEntry) => string | undefined
): SettingsSearchResult[] {
  const results: SettingsSearchResult[] = []
  for (const section of sections) {
    const seenTitles = new Set<string>()
    getSettingsSectionSearchEntries(section).forEach((entry, index) => {
      if (seenTitles.has(entry.title)) {
        return
      }
      seenTitles.add(entry.title)
      const isPane = index === 0
      results.push({
        key: `${section.id}\u0000${entry.title}`,
        section,
        entry,
        isPane,
        targetId: isPane
          ? section.id
          : (entry.targetSectionId ??
            resolveAnchorId(section, entry) ??
            getSettingsTitleTargetId(entry.title))
      })
    })
  }
  return results
}

export function rankSettingsSearchResults(
  query: string,
  results: readonly SettingsSearchResult[]
): SettingsSearchResult[] {
  if (normalizeSettingsSearchQuery(query) === '') {
    return []
  }
  return rankSettingsSearchItems(
    query,
    results,
    (result) => result.entry,
    (result) => ({ firstEntryIsPane: result.isPane })
  ).map(({ item }) => item)
}

/** Range of a title's first case-insensitive match so the row can mark it. */
export function getSettingsSearchTitleMatchRanges(title: string, query: string): MatchRange[] {
  const needle = query.trim().toLowerCase()
  const haystack = title.toLowerCase()
  // Lowercasing can change length (e.g. İ); skip marking rather than mis-slice.
  if (needle === '' || haystack.length !== title.length) {
    return []
  }
  const start = haystack.indexOf(needle)
  return start === -1 ? [] : [{ start, end: start + needle.length }]
}
