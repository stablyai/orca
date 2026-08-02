import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export type SettingsSearchEntry = {
  title: string
  description?: string
  keywords?: string[]
  cmdJKeywords?: string[]
  targetSectionId?: string
}

export const SETTINGS_SEARCH_QUERY_MAX_BYTES = 2 * 1024
const SETTINGS_SEARCH_NO_MATCH_SCORE = 0
const SETTINGS_SEARCH_EMPTY_QUERY_SCORE = 1

type SettingsSearchScoreTier = {
  exact: number
  prefix: number
  substring: number
}

type SettingsSearchRankCandidate<T> = {
  item: T
  index: number
  score: number
}

export type RankedSettingsSearchItem<T> = {
  item: T
  score: number
}

const PANE_TITLE_SCORE: SettingsSearchScoreTier = {
  exact: 900,
  prefix: 850,
  substring: 800
}

const ENTRY_TITLE_SCORE: SettingsSearchScoreTier = {
  exact: 700,
  prefix: 650,
  substring: 600
}

const DESCRIPTION_SCORE: SettingsSearchScoreTier = {
  exact: 500,
  prefix: 450,
  substring: 400
}

const KEYWORD_SCORE: SettingsSearchScoreTier = {
  exact: 300,
  prefix: 250,
  substring: 200
}

export function isSettingsSearchQueryTooLarge(
  query: string,
  maxBytes = SETTINGS_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export function normalizeSettingsSearchQuery(query: string): string {
  return query.trim().toLowerCase()
}

function scoreSettingsSearchText(
  normalizedQuery: string,
  value: string | undefined,
  tier: SettingsSearchScoreTier
): number {
  if (!value) {
    return SETTINGS_SEARCH_NO_MATCH_SCORE
  }
  const normalizedValue = value.toLowerCase()
  if (normalizedValue === normalizedQuery) {
    return tier.exact
  }
  if (normalizedValue.startsWith(normalizedQuery)) {
    return tier.prefix
  }
  if (normalizedValue.includes(normalizedQuery)) {
    return tier.substring
  }
  return SETTINGS_SEARCH_NO_MATCH_SCORE
}

function scoreSettingsSearchValues(
  normalizedQuery: string,
  values: readonly string[] | undefined,
  tier: SettingsSearchScoreTier
): number {
  return (values ?? []).reduce(
    (score, value) => Math.max(score, scoreSettingsSearchText(normalizedQuery, value, tier)),
    SETTINGS_SEARCH_NO_MATCH_SCORE
  )
}

export function scoreSettingsSearch(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): number {
  if (isSettingsSearchQueryTooLarge(query)) {
    return SETTINGS_SEARCH_NO_MATCH_SCORE
  }
  const normalizedQuery = normalizeSettingsSearchQuery(query)
  if (!normalizedQuery) {
    return SETTINGS_SEARCH_EMPTY_QUERY_SCORE
  }

  const values = Array.isArray(entries) ? entries : [entries]
  return values.reduce((score, entry, index) => {
    // Why: Settings passes the pane entry first so pane-title hits outrank
    // lower-level setting titles without adding a second search-entry shape.
    const titleScore = index === 0 ? PANE_TITLE_SCORE : ENTRY_TITLE_SCORE
    return Math.max(
      score,
      scoreSettingsSearchText(normalizedQuery, entry.title, titleScore),
      scoreSettingsSearchText(normalizedQuery, entry.description, DESCRIPTION_SCORE),
      scoreSettingsSearchValues(normalizedQuery, entry.keywords, KEYWORD_SCORE)
    )
  }, SETTINGS_SEARCH_NO_MATCH_SCORE)
}

export function getSettingsSectionSearchEntries(section: {
  title: string
  description: string
  searchEntries: readonly SettingsSearchEntry[]
}): SettingsSearchEntry[] {
  // Why: sidebar ranking and active content filtering must receive the same
  // pane-level entry, otherwise pane-title-only hits can rank but render blank.
  return [{ title: section.title, description: section.description }, ...section.searchEntries]
}

export function rankSettingsSearchItems<T>(
  query: string,
  items: readonly T[],
  getEntries: (item: T) => SettingsSearchEntry | SettingsSearchEntry[]
): RankedSettingsSearchItem<T>[] {
  if (isSettingsSearchQueryTooLarge(query)) {
    return []
  }
  if (!normalizeSettingsSearchQuery(query)) {
    return items.map((item) => ({ item, score: SETTINGS_SEARCH_EMPTY_QUERY_SCORE }))
  }

  return items
    .map(
      (item, index): SettingsSearchRankCandidate<T> => ({
        item,
        index,
        score: scoreSettingsSearch(query, getEntries(item))
      })
    )
    .filter((candidate) => candidate.score > SETTINGS_SEARCH_NO_MATCH_SCORE)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item, score }) => ({ item, score }))
}

export function matchesSettingsSearch(
  query: string,
  entries: SettingsSearchEntry | SettingsSearchEntry[]
): boolean {
  return scoreSettingsSearch(query, entries) > SETTINGS_SEARCH_NO_MATCH_SCORE
}
