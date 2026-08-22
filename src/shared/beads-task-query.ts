// Why: GitHub-style query-bar semantics for the Beads source — one raw string
// ('is:open assignee:@me label:x') is the single source of truth for presets,
// the Filters popover, fetch routing, and client-side filtering.
import type { BeadsIssue, BeadsIssuePreset, BeadsIssueStatus } from './beads-types'
import { tokenizeSearchQueryWithRaw } from './task-query'

export type ParsedBeadsTaskQuery = {
  /** OR'd together; empty means "any status" (fetch must include closed). */
  statuses: BeadsIssueStatus[]
  /** `is:ready` — bd's unblocked-open view (`bd ready`). */
  ready: boolean
  /** Issue types from `is:bug` etc.; any-of. */
  types: string[]
  /** AND'd, like GitHub's label qualifiers. */
  labels: string[]
  /** `assignee:<x>`; '@me' resolves to the repo host's actor. */
  assignee: string | null
  /** `no:assignee`. */
  noAssignee: boolean
  /** From `priority:p0`..`priority:p4` (bare 0-4 accepted); any-of. */
  priorities: number[]
  /** Raw unknown tokens/phrases for round-trip serialization. */
  freeText: string
  /** Unquoted free-text terms; every term must substring-match some field. */
  freeTextTerms: string[]
}

// `is:in-progress` is accepted as a spelling of the bd status.
const BEADS_QUERY_STATUS_ALIASES: Record<string, BeadsIssueStatus> = {
  open: 'open',
  closed: 'closed',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  blocked: 'blocked',
  deferred: 'deferred'
}

const BEADS_QUERY_STATUS_ORDER: readonly BeadsIssueStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'deferred',
  'closed'
]

/** bd's built-in issue types, addressable as `is:<type>`; order is the Filters facet order. */
export const BEADS_QUERY_ISSUE_TYPES: readonly string[] = [
  'task',
  'bug',
  'feature',
  'chore',
  'epic',
  'milestone',
  'decision',
  'spike',
  'story'
]

/** Core work types shown when a query has no type qualifiers; the rest are opt-in. */
export const BEADS_CORE_ISSUE_TYPES: readonly string[] = ['task', 'bug', 'feature', 'chore']

function parseBeadsPriorityValue(value: string): number | null {
  const match = /^p?([0-4])$/i.exec(value)
  return match ? Number(match[1]) : null
}

export function parseBeadsTaskQuery(rawQuery: string): ParsedBeadsTaskQuery {
  const query: ParsedBeadsTaskQuery = {
    statuses: [],
    ready: false,
    types: [],
    labels: [],
    assignee: null,
    noAssignee: false,
    priorities: [],
    freeText: '',
    freeTextTerms: []
  }
  const freeTextRaw: string[] = []
  for (const { value: token, raw } of tokenizeSearchQueryWithRaw(rawQuery.trim())) {
    const [rawKey, ...rest] = token.split(':')
    const value = rest.join(':').trim()
    const key = rawKey.toLowerCase()
    if (!value) {
      freeTextRaw.push(raw)
      query.freeTextTerms.push(token)
      continue
    }
    const normalizedValue = value.toLowerCase()
    if (key === 'is') {
      // `is:issue` is a GitHub-parity no-op: everything in beads is an issue.
      if (normalizedValue === 'issue') {
        continue
      }
      if (normalizedValue === 'ready') {
        query.ready = true
        continue
      }
      const status = BEADS_QUERY_STATUS_ALIASES[normalizedValue]
      if (status) {
        if (!query.statuses.includes(status)) {
          query.statuses.push(status)
        }
        continue
      }
      if (BEADS_QUERY_ISSUE_TYPES.includes(normalizedValue)) {
        if (!query.types.includes(normalizedValue)) {
          query.types.push(normalizedValue)
        }
        continue
      }
    }
    if (key === 'label') {
      query.labels.push(value)
      continue
    }
    if (key === 'assignee') {
      query.assignee = value
      continue
    }
    if (key === 'no' && normalizedValue === 'assignee') {
      query.noAssignee = true
      continue
    }
    if (key === 'priority') {
      const priority = parseBeadsPriorityValue(value)
      if (priority !== null) {
        if (!query.priorities.includes(priority)) {
          query.priorities.push(priority)
        }
        continue
      }
    }
    // Unknown qualifiers and quoted phrases fall through to free text.
    freeTextRaw.push(raw)
    query.freeTextTerms.push(token)
  }
  query.statuses.sort(
    (a, b) => BEADS_QUERY_STATUS_ORDER.indexOf(a) - BEADS_QUERY_STATUS_ORDER.indexOf(b)
  )
  query.priorities.sort((a, b) => a - b)
  query.freeText = freeTextRaw.join(' ').trim()
  return query
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

/**
 * Serialize back to a raw search string. Round-trips with parseBeadsTaskQuery
 * for the qualifiers it understands; freeText is appended last.
 */
export function serializeBeadsTaskQuery(q: ParsedBeadsTaskQuery): string {
  const parts: string[] = []
  for (const status of q.statuses) {
    parts.push(`is:${status}`)
  }
  if (q.ready) {
    parts.push('is:ready')
  }
  for (const type of q.types) {
    parts.push(`is:${type}`)
  }
  for (const priority of q.priorities) {
    parts.push(`priority:p${priority}`)
  }
  if (q.assignee) {
    parts.push(`assignee:${quoteIfNeeded(q.assignee)}`)
  }
  if (q.noAssignee) {
    parts.push('no:assignee')
  }
  for (const label of q.labels) {
    parts.push(`label:${quoteIfNeeded(label)}`)
  }
  if (q.freeText) {
    parts.push(q.freeText)
  }
  return parts.join(' ')
}

export type BeadsTaskQueryFilterKey = 'statuses' | 'priorities' | 'types' | 'labels' | 'assignee'

/**
 * Apply one facet change to a raw query string and return the updated string.
 * Multi-value keys take the full next array; `assignee` takes a value or null
 * (setting it clears `no:assignee`).
 */
export function withBeadsQualifier(
  rawQuery: string,
  key: BeadsTaskQueryFilterKey,
  value: string | string[] | null
): string {
  const parsed = parseBeadsTaskQuery(rawQuery)
  const values = Array.isArray(value) ? value : []
  switch (key) {
    case 'statuses':
      parsed.statuses = [
        ...new Set(
          values
            .map((status) => BEADS_QUERY_STATUS_ALIASES[status])
            .filter((status): status is BeadsIssueStatus => status !== undefined)
        )
      ]
      break
    case 'priorities':
      parsed.priorities = values
        .map((priority) => parseBeadsPriorityValue(priority))
        .filter((priority): priority is number => priority !== null)
      break
    case 'types':
      parsed.types = values
      break
    case 'labels':
      parsed.labels = values
      break
    case 'assignee':
      parsed.assignee = typeof value === 'string' ? value : null
      parsed.noAssignee = false
      break
  }
  return serializeBeadsTaskQuery(parsed)
}

/** True when any Filters-popover facet (not free text or is:ready) is set. */
export function hasBeadsFacetQualifiers(q: ParsedBeadsTaskQuery): boolean {
  return (
    q.statuses.length > 0 ||
    q.types.length > 0 ||
    q.priorities.length > 0 ||
    q.labels.length > 0 ||
    q.assignee !== null
  )
}

/** True when the query narrows results beyond the ready/status fetch scope. */
export function isBeadsTaskQueryFiltering(q: ParsedBeadsTaskQuery): boolean {
  return (
    q.statuses.length > 0 ||
    q.types.length > 0 ||
    q.priorities.length > 0 ||
    q.labels.length > 0 ||
    q.assignee !== null ||
    q.noAssignee ||
    q.freeTextTerms.length > 0
  )
}

/**
 * Client-side predicate over a fetched issue. `ready` and `assignee:@me` are
 * fetch-side concerns (bd ready / host actor resolution) and are not
 * re-checked here.
 */
export function matchesBeadsTaskQuery(issue: BeadsIssue, q: ParsedBeadsTaskQuery): boolean {
  if (q.statuses.length > 0 && !q.statuses.includes(issue.status)) {
    return false
  }
  if (q.types.length > 0 && !q.types.includes(issue.issueType)) {
    return false
  }
  if (q.priorities.length > 0 && !q.priorities.includes(issue.priority)) {
    return false
  }
  // Labels AND together like GitHub's label qualifiers; the other facets are any-of.
  if (q.labels.length > 0 && !q.labels.every((label) => issue.labels.includes(label))) {
    return false
  }
  if (q.assignee !== null && q.assignee !== '@me' && issue.assignee !== q.assignee) {
    return false
  }
  if (q.noAssignee && issue.assignee) {
    return false
  }
  return q.freeTextTerms.every((term) => {
    const needle = term.toLowerCase()
    return (
      issue.id.toLowerCase().includes(needle) ||
      issue.title.toLowerCase().includes(needle) ||
      issue.labels.some((label) => label.toLowerCase().includes(needle))
    )
  })
}

/** Preset pills write these queries; mirrors getTaskPresetQuery for GitHub. */
export function getBeadsPresetQuery(preset: BeadsIssuePreset): string {
  switch (preset) {
    case 'open':
      return 'is:open'
    case 'assigned':
      return 'is:open assignee:@me'
    case 'ready':
      return 'is:ready'
  }
}

const BEADS_PRESET_IDS: readonly BeadsIssuePreset[] = ['open', 'assigned', 'ready']

/** The preset whose query is semantically equal to `rawQuery`, if any. */
export function getBeadsPresetForQuery(rawQuery: string): BeadsIssuePreset | null {
  const canonical = serializeBeadsTaskQuery(parseBeadsTaskQuery(rawQuery))
  for (const preset of BEADS_PRESET_IDS) {
    if (canonical === serializeBeadsTaskQuery(parseBeadsTaskQuery(getBeadsPresetQuery(preset)))) {
      return preset
    }
  }
  return null
}

/** Issues = core work types; ADRs = `is:decision` (Architecture Decision Records). */
export type BeadsTypeScope = 'issues' | 'adrs'

/**
 * The type-scope tab a query lights, mirroring how GitHub's Issues/PRs tabs
 * bind to is:issue/is:pr: no type qualifiers -> 'issues', exactly {decision}
 * -> 'adrs', any other explicit type set -> null.
 */
export function getBeadsTypeScopeForQuery(rawQuery: string): BeadsTypeScope | null {
  const { types } = parseBeadsTaskQuery(rawQuery)
  if (types.length === 0) {
    return 'issues'
  }
  return types.length === 1 && types[0] === 'decision' ? 'adrs' : null
}

/** Rewrite the query's type qualifiers for a tab: 'adrs' -> is:decision, 'issues' -> none. */
export function withBeadsTypeScope(rawQuery: string, scope: BeadsTypeScope): string {
  return withBeadsQualifier(rawQuery, 'types', scope === 'adrs' ? ['decision'] : [])
}

export type BeadsIssueFetchScope = 'open' | 'all' | 'ready'

export type BeadsIssueFetchPlan = {
  /** 'all' runs `bd list --all` (includes closed); 'ready' runs `bd ready`. */
  statusScope: BeadsIssueFetchScope
  /** '@me' resolves on the repo host; a specific value maps to `-a <value>`. */
  assignee: string | null
  /** Closest bd view for hosts predating beads-query-filter.v1 (their zod strips the new params). */
  legacyPreset: BeadsIssuePreset
}

/** Routes a parsed query to one bd fetch; everything else filters client-side. */
export function getBeadsFetchPlan(q: ParsedBeadsTaskQuery): BeadsIssueFetchPlan {
  if (q.ready) {
    return { statusScope: 'ready', assignee: q.assignee, legacyPreset: 'ready' }
  }
  // No status tokens means "any", which needs closed issues too.
  const statusScope = q.statuses.length === 0 || q.statuses.includes('closed') ? 'all' : 'open'
  return {
    statusScope,
    assignee: q.assignee,
    legacyPreset: q.assignee === '@me' ? 'assigned' : 'open'
  }
}
