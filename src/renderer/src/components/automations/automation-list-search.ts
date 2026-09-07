import {
  getActiveAutomationListSearchQuery,
  resolveAutomationListSearchQuery
} from './automation-list-search-query'

export {
  AUTOMATION_LIST_SEARCH_QUERY_MAX_BYTES,
  clampAutomationListSearchQueryInput,
  getActiveAutomationListSearchQuery,
  isAutomationListSearchQueryTooLarge,
  resolveAutomationListSearchQuery,
  type AutomationListSearchQueryResolution
} from './automation-list-search-query'

// Why: prompts can be multi-MB agent instructions. Index only a fixed prefix so
// lowercasing/includes stay O(bound) per automation rather than O(prompt size).
export const AUTOMATION_LIST_SEARCH_NAME_MAX_CODE_UNITS = 512
export const AUTOMATION_LIST_SEARCH_PROJECT_MAX_CODE_UNITS = 1_024
export const AUTOMATION_LIST_SEARCH_WORKSPACE_MAX_CODE_UNITS = 512
export const AUTOMATION_LIST_SEARCH_AGENT_MAX_CODE_UNITS = 128
export const AUTOMATION_LIST_SEARCH_HOST_MAX_CODE_UNITS = 256
/** Design doc: at most the first 2,048 prompt characters are searchable. */
export const AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS = 2_048

/** Indexed when a local automation has no resolved project so "unknown" still matches. */
export const AUTOMATION_LIST_SEARCH_UNKNOWN_PROJECT = 'unknown project'

export type AutomationListSearchFields = {
  name: string
  project: string
  prompt: string
  workspace?: string | null
  agent?: string | null
  host?: string | null
}

/** Lowercased, length-capped fields ready for substring match. */
export type AutomationListSearchIndex = {
  name: string
  project: string
  workspace: string
  agent: string
  host: string
  prompt: string
}

/** Cheapest field first so the prompt prefix is scanned least often. */
const SEARCH_FIELD_CAPS: readonly (readonly [keyof AutomationListSearchIndex, number])[] = [
  ['name', AUTOMATION_LIST_SEARCH_NAME_MAX_CODE_UNITS],
  ['agent', AUTOMATION_LIST_SEARCH_AGENT_MAX_CODE_UNITS],
  ['host', AUTOMATION_LIST_SEARCH_HOST_MAX_CODE_UNITS],
  ['workspace', AUTOMATION_LIST_SEARCH_WORKSPACE_MAX_CODE_UNITS],
  ['project', AUTOMATION_LIST_SEARCH_PROJECT_MAX_CODE_UNITS],
  ['prompt', AUTOMATION_LIST_SEARCH_PROMPT_MAX_CODE_UNITS]
]

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
  const index = {} as AutomationListSearchIndex
  for (const [field, maxCodeUnits] of SEARCH_FIELD_CAPS) {
    index[field] = normalizeAutomationListSearchField(fields[field], maxCodeUnits)
  }
  return index
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
  for (const [field] of SEARCH_FIELD_CAPS) {
    if (index[field].includes(activeQuery)) {
      return true
    }
  }
  return false
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
 * indexes or re-run filtering. Fields are capped first so fingerprinting a
 * multi-MB prompt costs the same as indexing it.
 */
export function buildAutomationListSearchFingerprint(
  sources: readonly AutomationListSearchFields[],
  keys?: readonly string[]
): string {
  let fingerprint = ''
  for (let i = 0; i < sources.length; i += 1) {
    if (i > 0) {
      fingerprint += '\u0000'
    }
    const source = sources[i]
    if (!source) {
      continue
    }
    fingerprint += keys?.[i] ?? ''
    for (const [field, maxCodeUnits] of SEARCH_FIELD_CAPS) {
      fingerprint += `\u0001${truncateAutomationListSearchField(source[field] ?? '', maxCodeUnits)}`
    }
  }
  return fingerprint
}
