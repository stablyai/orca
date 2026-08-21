import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

/** Pasted queries above this are rejected so filtering never runs on unbounded input. */
export const AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES = 2 * 1024

// Why: prompts can be multi-MB agent instructions. Index only a fixed prefix so
// lowercasing/includes stay O(bound) per automation rather than O(prompt size).
export const AUTOMATION_LIST_SEARCH_NAME_MAX_CODE_UNITS = 512
export const AUTOMATION_LIST_SEARCH_PROJECT_MAX_CODE_UNITS = 1_024
export const AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS = 8 * 1024

/** Indexed when a local automation has no resolved project so "unknown" still matches. */
export const AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT = 'unknown project'

export type AutomationListSearchFields = {
  name: string
  project: string
  prompt: string
}

/** Lowercased, length-capped fields ready for substring match. */
export type AutomationListSearchIndex = {
  name: string
  project: string
  prompt: string
}

export type AutomationListSearchQueryResolution =
  | { status: 'inactive' }
  | { status: 'too_large' }
  | { status: 'active'; query: string }

export function isAutomationListSearchQueryTooLarge(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(rawQuery, maxBytes)
}

/**
 * Caps the controlled input value so a multi-MB paste cannot pin renderer
 * memory. Keeping maxBytes+1 code units is enough for the over-limit check
 * (`length > maxBytes`) while discarding the rest of the paste.
 */
export function clampAutomationListSearchQueryInput(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): string {
  const maxStoredCodeUnits = maxBytes + 1
  if (rawQuery.length <= maxStoredCodeUnits) {
    return rawQuery
  }
  return rawQuery.slice(0, maxStoredCodeUnits)
}

export function resolveAutomationListSearchQuery(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): AutomationListSearchQueryResolution {
  // Why: length pre-check short-circuits multi-MB pastes before UTF-8 scan.
  if (isClipboardTextByteLengthOverLimit(rawQuery, maxBytes)) {
    return { status: 'too_large' }
  }
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return { status: 'inactive' }
  }
  return { status: 'active', query }
}

/** Active lowercase query, or null when search must not run. */
export function getActiveAutomationListSearchQuery(
  rawQuery: string,
  maxBytes = AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES
): string | null {
  const resolved = resolveAutomationListSearchQuery(rawQuery, maxBytes)
  return resolved.status === 'active' ? resolved.query : null
}

/** Avoid splitting a surrogate pair at the cap boundary. */
export function truncateAutomationListSearchField(value: string, maxCodeUnits: number): string {
  if (value.length <= maxCodeUnits) {
    return value
  }
  let end = maxCodeUnits
  const last = value.charCodeAt(end - 1)
  // High surrogate at the cut would leave an orphan low surrogate.
  if (last >= 0xd800 && last <= 0xdbff) {
    end -= 1
  }
  return value.slice(0, end)
}

export function normalizeAutomationListSearchField(
  value: string | null | undefined,
  maxCodeUnits: number
): string {
  if (value == null || value === '') {
    return ''
  }
  return truncateAutomationListSearchField(value, maxCodeUnits).toLowerCase()
}

export function buildAutomationListSearchIndex(
  fields: AutomationListSearchFields
): AutomationListSearchIndex {
  return {
    name: normalizeAutomationListSearchField(
      fields.name,
      AUTOMATION_LIST_SEARCH_NAME_MAX_CODE_UNITS
    ),
    project: normalizeAutomationListSearchField(
      fields.project,
      AUTOMATION_LIST_SEARCH_PROJECT_MAX_CODE_UNITS
    ),
    prompt: normalizeAutomationListSearchField(
      fields.prompt,
      AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS
    )
  }
}

export function buildAutomationProjectSearchText(parts: {
  displayName?: string | null
  path?: string | null
}): string {
  const joined = [parts.displayName, parts.path]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
  return joined || AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT
}

export function automationListSearchIndexMatches(
  index: AutomationListSearchIndex,
  activeQuery: string
): boolean {
  // Why: check short fields first so huge-prompt includes rarely run.
  return (
    index.name.includes(activeQuery) ||
    index.project.includes(activeQuery) ||
    index.prompt.includes(activeQuery)
  )
}

export function automationListSearchFieldsMatch(
  fields: AutomationListSearchFields,
  rawQuery: string
): boolean {
  const resolved = resolveAutomationListSearchQuery(rawQuery)
  if (resolved.status === 'too_large') {
    return false
  }
  if (resolved.status === 'inactive') {
    return true
  }
  return automationListSearchIndexMatches(buildAutomationListSearchIndex(fields), resolved.query)
}

/**
 * Filters with an already-resolved active query. Callers must pass null/skip
 * when search is inactive or too large so this never runs "for free".
 */
export function filterByActiveAutomationListSearchQuery<T>(
  items: readonly T[],
  indexes: readonly AutomationListSearchIndex[],
  activeQuery: string
): T[] {
  if (indexes.length !== items.length) {
    return [...items]
  }
  const matches: T[] = []
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]
    const index = indexes[i]
    if (item !== undefined && index && automationListSearchIndexMatches(index, activeQuery)) {
      matches.push(item)
    }
  }
  return matches
}

/**
 * Filters items by a prebuilt index. Empty and oversized queries leave the
 * original array reference untouched so the list stays unfiltered and search
 * work is skipped entirely.
 */
export function filterByAutomationListSearchIndex<T>(
  items: readonly T[],
  indexes: readonly AutomationListSearchIndex[],
  rawQuery: string
): readonly T[] {
  const activeQuery = getActiveAutomationListSearchQuery(rawQuery)
  if (activeQuery === null) {
    return items
  }
  return filterByActiveAutomationListSearchQuery(items, indexes, activeQuery)
}

/** Builds indexes then filters. Prefer prebuilt indexes when filtering often. */
export function filterByAutomationListSearch<T>(
  items: readonly T[],
  rawQuery: string,
  getFields: (item: T) => AutomationListSearchFields
): readonly T[] {
  const activeQuery = getActiveAutomationListSearchQuery(rawQuery)
  if (activeQuery === null) {
    return items
  }
  const matches: T[] = []
  for (const item of items) {
    if (
      automationListSearchIndexMatches(buildAutomationListSearchIndex(getFields(item)), activeQuery)
    ) {
      matches.push(item)
    }
  }
  return matches
}

/**
 * Content fingerprint for search-relevant fields only. Used so list refresh
 * ticks that replace arrays with equivalent search content do not rebuild
 * indexes or re-run filtering.
 */
export function buildAutomationListSearchFingerprint(
  sources: readonly AutomationListSearchFields[]
): string {
  if (sources.length === 0) {
    return ''
  }
  let fingerprint = ''
  for (let i = 0; i < sources.length; i += 1) {
    if (i > 0) {
      fingerprint += '\u0000'
    }
    const source = sources[i]
    if (!source) {
      continue
    }
    fingerprint += `${source.name}\u0001${source.project}\u0001${source.prompt}`
  }
  return fingerprint
}
