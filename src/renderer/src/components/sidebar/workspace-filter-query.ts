/**
 * GitHub-style filter grammar for the sidebar workspace list.
 *
 * `orca host:mac,ssh -branch:main is:pinned "two words" any:8080`
 *
 * Bare words and quoted phrases are free text matched against the printed
 * identity of a row (name, branch, project). Qualifiers narrow by one field,
 * AND together, OR within a comma list, and `-` negates one. `any:` widens the
 * free-text match to every palette field (comments, reviews, ports, tasks).
 */

export const WORKSPACE_FILTER_QUALIFIER_KEYS = [
  'name',
  'repo',
  'branch',
  'host',
  'path',
  'status',
  'is',
  'pr',
  'issue',
  'any'
] as const

export type WorkspaceFilterQualifierKey = (typeof WORKSPACE_FILTER_QUALIFIER_KEYS)[number]

export const WORKSPACE_FILTER_IS_VALUES = [
  'pinned',
  'main',
  'sleeping',
  'active',
  'detached',
  'cli',
  'automation',
  'unread',
  'folder'
] as const

export type WorkspaceFilterIsValue = (typeof WORKSPACE_FILTER_IS_VALUES)[number]

// Why a Map: alias names are query vocabulary, not UI copy.
const QUALIFIER_ALIASES: ReadonlyMap<string, WorkspaceFilterQualifierKey> = new Map([
  ['name', 'name'],
  ['n', 'name'],
  ['title', 'name'],
  ['repo', 'repo'],
  ['r', 'repo'],
  ['project', 'repo'],
  ['p', 'repo'],
  ['branch', 'branch'],
  ['b', 'branch'],
  ['host', 'host'],
  ['h', 'host'],
  ['hosts', 'host'],
  ['path', 'path'],
  ['dir', 'path'],
  ['status', 'status'],
  ['s', 'status'],
  ['is', 'is'],
  ['pr', 'pr'],
  ['mr', 'pr'],
  ['issue', 'issue'],
  ['any', 'any'],
  ['all', 'any'],
  ['text', 'any']
])

export type WorkspaceFilterClause = {
  key: WorkspaceFilterQualifierKey
  /** Lower-cased, trimmed, empty entries dropped; OR-ed together. */
  values: readonly string[]
  negated: boolean
}

export type WorkspaceFilterTerm = {
  text: string
  negated: boolean
}

export type ParsedWorkspaceFilterQuery = {
  /** Free text, in query order. */
  terms: readonly WorkspaceFilterTerm[]
  clauses: readonly WorkspaceFilterClause[]
  /** True when at least one term or clause survives parsing. */
  isActive: boolean
}

const EMPTY_PARSED: ParsedWorkspaceFilterQuery = {
  terms: [],
  clauses: [],
  isActive: false
}

export type WorkspaceFilterQueryToken = {
  raw: string
  start: number
  end: number
}

/** Splits on whitespace, keeping double-quoted runs (even with spaces) intact. */
export function tokenizeWorkspaceFilterQuery(query: string): WorkspaceFilterQueryToken[] {
  const tokens: WorkspaceFilterQueryToken[] = []
  let index = 0
  while (index < query.length) {
    if (/\s/.test(query[index]!)) {
      index++
      continue
    }
    const start = index
    let inQuotes = false
    while (index < query.length) {
      const char = query[index]!
      if (char === '"') {
        inQuotes = !inQuotes
      } else if (!inQuotes && /\s/.test(char)) {
        break
      }
      index++
    }
    tokens.push({ raw: query.slice(start, index), start, end: index })
  }
  return tokens
}

function stripQuotes(value: string): string {
  return value.replace(/"/g, '')
}

function splitValues(rawValue: string): string[] {
  // Why: commas inside quotes are literal; `branch:"a, b"` is one value.
  const values: string[] = []
  let current = ''
  let inQuotes = false
  for (const char of rawValue) {
    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }
    if (char === ',' && !inQuotes) {
      values.push(current)
      current = ''
      continue
    }
    current += char
  }
  values.push(current)
  return values.map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0)
}

const QUALIFIER_TOKEN = /^(-?)([A-Za-z_]+):(.*)$/s

export function resolveWorkspaceFilterQualifierKey(
  key: string
): WorkspaceFilterQualifierKey | null {
  return QUALIFIER_ALIASES.get(key.toLowerCase()) ?? null
}

export function parseWorkspaceFilterQuery(query: string): ParsedWorkspaceFilterQuery {
  if (!query.trim()) {
    return EMPTY_PARSED
  }
  const terms: WorkspaceFilterTerm[] = []
  const clauses: WorkspaceFilterClause[] = []
  for (const token of tokenizeWorkspaceFilterQuery(query)) {
    const qualifier = QUALIFIER_TOKEN.exec(token.raw)
    const key = qualifier ? resolveWorkspaceFilterQualifierKey(qualifier[2]!) : null
    if (qualifier && key) {
      const values = splitValues(qualifier[3]!)
      // Why: `host:` with nothing after it is a qualifier being typed, not a
      // filter that matches nothing; blanking the list mid-keystroke is a trap.
      if (values.length === 0) {
        continue
      }
      clauses.push({ key, values, negated: qualifier[1] === '-' })
      continue
    }
    const negated = token.raw.startsWith('-') && token.raw.length > 1
    const text = stripQuotes(negated ? token.raw.slice(1) : token.raw).trim()
    if (text.length > 0) {
      terms.push({ text, negated })
    }
  }
  return { terms, clauses, isActive: terms.length > 0 || clauses.length > 0 }
}

/** Free text for the identity search: positive bare terms, space-joined. */
export function getWorkspaceFilterIdentityText(parsed: ParsedWorkspaceFilterQuery): string {
  return parsed.terms
    .filter((term) => !term.negated)
    .map((term) => term.text)
    .join(' ')
}

/** Free text for the widened `any:` search across every palette field. */
export function getWorkspaceFilterAnyText(parsed: ParsedWorkspaceFilterQuery): string {
  return parsed.clauses
    .filter((clause) => clause.key === 'any' && !clause.negated)
    .flatMap((clause) => clause.values)
    .join(' ')
}

/**
 * `is:` values the query asks for explicitly. An explicit ask outranks the
 * sidebar toggle that would otherwise hide that kind, so `is:sleeping` finds
 * sleeping workspaces even while "Hide sleeping" is on.
 */
export function getExplicitWorkspaceFilterKinds(
  parsed: ParsedWorkspaceFilterQuery
): ReadonlySet<WorkspaceFilterIsValue> {
  const kinds = new Set<WorkspaceFilterIsValue>()
  for (const clause of parsed.clauses) {
    if (clause.key !== 'is' || clause.negated) {
      continue
    }
    for (const kind of WORKSPACE_FILTER_IS_VALUES) {
      if (clause.values.includes(kind)) {
        kinds.add(kind)
      }
    }
  }
  return kinds
}
