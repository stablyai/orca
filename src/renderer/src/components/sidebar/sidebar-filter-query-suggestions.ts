import {
  resolveWorkspaceFilterQualifierKey,
  tokenizeWorkspaceFilterQuery,
  WORKSPACE_FILTER_IS_VALUES,
  WORKSPACE_FILTER_QUALIFIER_KEYS,
  type WorkspaceFilterQualifierKey
} from './workspace-filter-query'

export type SidebarFilterSuggestionCatalog = {
  hosts: readonly { id: string; label: string }[]
  repos: readonly string[]
  branches: readonly string[]
  statuses: readonly { id: string; label: string }[]
}

export type SidebarFilterSuggestion = {
  /** What the list shows. */
  label: string
  /** Set for qualifier-key suggestions; the UI maps it to a localized explanation. */
  qualifier?: WorkspaceFilterQualifierKey
  /** Muted identifier beside a value, e.g. the host id behind a label. */
  detail?: string
  /** Text that replaces the token under the caret. */
  replacement: string
}

export type SidebarFilterSuggestionSet = {
  /** Range of the query the replacement overwrites. */
  start: number
  end: number
  items: readonly SidebarFilterSuggestion[]
}

const MAX_SUGGESTIONS = 8

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((value) => value.trim().length > 0))].sort((a, b) =>
    a.localeCompare(b)
  )
}

function valueCandidates(
  key: WorkspaceFilterQualifierKey,
  catalog: SidebarFilterSuggestionCatalog
): { value: string; detail?: string }[] {
  switch (key) {
    case 'host':
      return catalog.hosts.map((host) => ({
        value: host.label,
        detail: host.id
      }))
    case 'repo':
      return uniqueSorted(catalog.repos).map((value) => ({ value }))
    case 'branch':
      return uniqueSorted(catalog.branches).map((value) => ({ value }))
    case 'status':
      return catalog.statuses.map((status) => ({
        value: status.label,
        detail: status.id
      }))
    case 'is':
      return WORKSPACE_FILTER_IS_VALUES.map((value) => ({ value }))
    case 'name':
    case 'path':
    case 'pr':
    case 'issue':
    case 'any':
      return []
  }
}

/**
 * Suggestions for the token under the caret: qualifier keys while a bare word
 * is being typed, and known values once a qualifier has its colon.
 * Returns null when there is nothing useful to offer.
 */
export function getSidebarFilterQuerySuggestions(args: {
  query: string
  caret: number
  catalog: SidebarFilterSuggestionCatalog
}): SidebarFilterSuggestionSet | null {
  const { query, caret, catalog } = args
  const token = tokenizeWorkspaceFilterQuery(query).find(
    (candidate) => candidate.start <= caret && caret <= candidate.end
  ) ?? { raw: '', start: caret, end: caret }
  const negation = token.raw.startsWith('-') ? '-' : ''
  const body = negation ? token.raw.slice(1) : token.raw
  const colon = body.indexOf(':')

  if (colon === -1) {
    // Why: quoted phrases are free text by intent, never a qualifier in progress.
    if (body.startsWith('"')) {
      return null
    }
    const needle = body.toLowerCase()
    const items = WORKSPACE_FILTER_QUALIFIER_KEYS.filter((key) => key.startsWith(needle)).map(
      (key) => ({
        label: `${key}:`,
        qualifier: key,
        replacement: `${negation}${key}:`
      })
    )
    return items.length ? { start: token.start, end: token.end, items } : null
  }

  const key = resolveWorkspaceFilterQualifierKey(body.slice(0, colon))
  if (!key) {
    return null
  }
  const rawValues = body.slice(colon + 1)
  const lastComma = rawValues.lastIndexOf(',')
  const keptPrefix = lastComma === -1 ? '' : rawValues.slice(0, lastComma + 1)
  const partial = (lastComma === -1 ? rawValues : rawValues.slice(lastComma + 1))
    .replace(/"/g, '')
    .toLowerCase()
  const items = valueCandidates(key, catalog)
    .filter(
      (candidate) =>
        candidate.value.toLowerCase().includes(partial) ||
        (candidate.detail?.toLowerCase().includes(partial) ?? false)
    )
    .slice(0, MAX_SUGGESTIONS)
    .map((candidate) => ({
      label: candidate.value,
      detail: candidate.detail,
      replacement: `${negation}${key}:${keptPrefix}${quoteIfNeeded(candidate.value)} `
    }))
  return items.length ? { start: token.start, end: token.end, items } : null
}

export function applySidebarFilterSuggestion(
  query: string,
  set: Pick<SidebarFilterSuggestionSet, 'start' | 'end'>,
  suggestion: SidebarFilterSuggestion
): { query: string; caret: number } {
  const next = query.slice(0, set.start) + suggestion.replacement + query.slice(set.end)
  return { query: next, caret: set.start + suggestion.replacement.length }
}
