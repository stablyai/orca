import type { MatchRange } from '../../../../../shared/palette-match/normalized-text'
import type { SettingsNavSection } from './settings-navigation-types'
import {
  foldSettingsSearchText,
  getSettingsSectionSearchEntries,
  normalizeSettingsSearchQuery,
  rankSettingsSearchItems,
  type SettingsSearchEntry
} from '../search/settings-search'
import { getSettingsTitleTargetId } from '../section-layout/settings-target-highlight'

// Enough to scan; past this the query is too broad to be useful.
export const SETTINGS_SEARCH_RESULT_LIMIT = 50

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

/** Range of a title's first match under the ranking fold, mapped back to the original title. */
export function getSettingsSearchTitleMatchRanges(title: string, query: string): MatchRange[] {
  const needle = normalizeSettingsSearchQuery(query)
  if (needle === '') {
    return []
  }
  // Fold per code point so each folded unit maps back to the original text it came from.
  let folded = ''
  const originalStarts: number[] = []
  const originalEnds: number[] = []
  let offset = 0
  for (const char of title) {
    const chunk = foldSettingsSearchText(char)
    for (let i = 0; i < chunk.length; i += 1) {
      originalStarts.push(offset)
      originalEnds.push(offset + char.length)
    }
    folded += chunk
    offset += char.length
  }
  const start = folded.indexOf(needle)
  if (start === -1) {
    return []
  }
  return [{ start: originalStarts[start], end: originalEnds[start + needle.length - 1] }]
}
