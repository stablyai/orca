export type ParsedTaskQuery = {
  scope: 'all' | 'issue' | 'pr'
  state: 'open' | 'closed' | 'all' | 'merged' | null
  draft: boolean
  assignee: string | null
  author: string | null
  reviewRequested: string | null
  reviewedBy: string | null
  labels: string[]
  freeText: string
}

type SearchQueryToken = {
  value: string
  raw: string
}

function tokenizeSearchQueryWithRaw(rawQuery: string): SearchQueryToken[] {
  const tokens: SearchQueryToken[] = []
  let value = ''
  let raw = ''
  let quote: '"' | "'" | null = null

  const flush = (): void => {
    if (value || raw) {
      tokens.push({ value, raw })
      value = ''
      raw = ''
    }
  }

  for (let i = 0; i < rawQuery.length; i += 1) {
    const char = rawQuery[i]
    if (/\s/.test(char) && quote === null) {
      flush()
      continue
    }
    raw += char
    if ((char === '"' || char === "'") && quote === null) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = null
      continue
    }
    value += char
  }
  flush()
  return tokens
}

export function tokenizeSearchQuery(rawQuery: string): string[] {
  return tokenizeSearchQueryWithRaw(rawQuery).map((token) => token.value)
}

export function parseTaskQuery(rawQuery: string): ParsedTaskQuery {
  const query: ParsedTaskQuery = {
    scope: 'all',
    state: null,
    draft: false,
    assignee: null,
    author: null,
    reviewRequested: null,
    reviewedBy: null,
    labels: [],
    freeText: ''
  }

  const freeTextTokens: string[] = []
  let sawIssueScope = false
  let sawPRScope = false
  for (const { value: token, raw } of tokenizeSearchQueryWithRaw(rawQuery.trim())) {
    const normalized = token.toLowerCase()
    if (normalized === 'is:issue') {
      sawIssueScope = true
      query.scope = sawPRScope ? 'all' : 'issue'
      continue
    }
    if (normalized === 'is:pr' || normalized === 'is:pull-request') {
      sawPRScope = true
      query.scope = sawIssueScope ? 'all' : 'pr'
      continue
    }
    if (normalized === 'is:open') {
      query.state = 'open'
      continue
    }
    if (normalized === 'is:closed') {
      query.state = 'closed'
      continue
    }
    if (normalized === 'is:merged') {
      query.state = 'merged'
      continue
    }
    if (normalized === 'is:draft') {
      query.scope = 'pr'
      query.state = 'open'
      query.draft = true
      continue
    }

    const [rawKey, ...rest] = token.split(':')
    const value = rest.join(':').trim()
    const key = rawKey.toLowerCase()
    if (!value) {
      freeTextTokens.push(raw)
      continue
    }

    if (key === 'assignee') {
      query.assignee = value
      continue
    }
    if (key === 'author') {
      query.author = value
      continue
    }
    if (key === 'review-requested') {
      query.scope = 'pr'
      query.reviewRequested = value
      continue
    }
    if (key === 'reviewed-by') {
      query.scope = 'pr'
      query.reviewedBy = value
      continue
    }
    if (key === 'label') {
      query.labels.push(value)
      continue
    }
    const normalizedValue = value.toLowerCase()
    if (
      key === 'state' &&
      (normalizedValue === 'open' ||
        normalizedValue === 'closed' ||
        normalizedValue === 'merged' ||
        normalizedValue === 'all')
    ) {
      query.state = normalizedValue
      continue
    }

    // Why: unknown qualifiers and exact phrases are passed through to GitHub
    // search as-is; reserializing stripped quotes changes search semantics.
    freeTextTokens.push(raw)
  }

  if (query.draft) {
    query.scope = 'pr'
    query.state = 'open'
  } else if (
    query.state === 'merged' ||
    query.reviewRequested !== null ||
    query.reviewedBy !== null
  ) {
    query.scope = 'pr'
  }
  query.freeText = freeTextTokens.join(' ').trim()
  return query
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value
}

/**
 * Serialize a ParsedTaskQuery back to a raw search string. Round-trips with
 * parseTaskQuery for the qualifiers it understands; freeText is appended last.
 */
export function serializeTaskQuery(q: ParsedTaskQuery): string {
  const parts: string[] = []
  if (q.scope === 'pr') {
    parts.push('is:pr')
  } else if (q.scope === 'issue') {
    parts.push('is:issue')
  }
  if (q.state === 'open') {
    parts.push('is:open')
  } else if (q.state === 'closed') {
    parts.push('is:closed')
  } else if (q.state === 'merged') {
    parts.push('is:merged')
  } else if (q.state === 'all') {
    parts.push('state:all')
  }
  if (q.draft) {
    parts.push('is:draft')
  }
  if (q.author) {
    parts.push(`author:${quoteIfNeeded(q.author)}`)
  }
  if (q.assignee) {
    parts.push(`assignee:${quoteIfNeeded(q.assignee)}`)
  }
  if (q.reviewRequested) {
    parts.push(`review-requested:${quoteIfNeeded(q.reviewRequested)}`)
  }
  if (q.reviewedBy) {
    parts.push(`reviewed-by:${quoteIfNeeded(q.reviewedBy)}`)
  }
  for (const label of q.labels) {
    parts.push(`label:${quoteIfNeeded(label)}`)
  }
  if (q.freeText) {
    parts.push(q.freeText)
  }
  return parts.join(' ')
}

export type TaskQueryFilterKey =
  | 'author'
  | 'assignee'
  | 'reviewRequested'
  | 'reviewedBy'
  | 'labels'
  | 'state'
  | 'draft'

/**
 * Apply a filter change to a raw query string and return the updated raw string.
 * For single-value keys, pass `null` to clear. For `labels`, pass the full next
 * array (caller manages add/remove).
 */
export function withQualifier(
  rawQuery: string,
  key: TaskQueryFilterKey,
  value: string | string[] | null
): string {
  const parsed = parseTaskQuery(rawQuery)
  switch (key) {
    case 'author':
      parsed.author = typeof value === 'string' ? value : null
      break
    case 'assignee':
      parsed.assignee = typeof value === 'string' ? value : null
      break
    case 'reviewRequested':
      parsed.reviewRequested = typeof value === 'string' ? value : null
      if (parsed.reviewRequested) {
        parsed.scope = 'pr'
      }
      break
    case 'reviewedBy':
      parsed.reviewedBy = typeof value === 'string' ? value : null
      if (parsed.reviewedBy) {
        parsed.scope = 'pr'
      }
      break
    case 'labels':
      parsed.labels = Array.isArray(value) ? value : []
      break
    case 'state':
      parsed.state =
        value === 'open' || value === 'closed' || value === 'merged' || value === 'all'
          ? value
          : null
      if (parsed.state === 'merged') {
        parsed.scope = 'pr'
      }
      if (parsed.state !== 'open') {
        parsed.draft = false
      }
      break
    case 'draft':
      parsed.draft = value === 'true'
      if (parsed.draft) {
        parsed.scope = 'pr'
        parsed.state = 'open'
      }
      break
  }
  return serializeTaskQuery(parsed)
}

/**
 * Strip any `repo:owner/name` qualifiers from a raw search string.
 *
 * Why: in cross-repo mode the renderer fans the search out to each selected
 * repo via IPC. A stray `repo:` qualifier would pin every fan-out call to one
 * repo and silently zero out the others, so it must be removed before dispatch.
 * Tokens containing whitespace are re-quoted so quoted-label values like
 * `label:"needs review"` round-trip cleanly.
 */
export function stripRepoQualifiers(rawQuery: string): string {
  const kept: string[] = []
  for (const token of tokenizeSearchQuery(rawQuery.trim())) {
    if (/^repo:[^\s]+$/i.test(token)) {
      continue
    }
    if (/\s/.test(token)) {
      const [rawKey, ...rest] = token.split(':')
      if (rest.length > 0) {
        kept.push(`${rawKey}:"${rest.join(':')}"`)
      } else {
        kept.push(`"${token}"`)
      }
    } else {
      kept.push(token)
    }
  }
  return kept.join(' ')
}
