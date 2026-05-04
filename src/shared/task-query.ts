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

export function tokenizeSearchQuery(rawQuery: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(rawQuery)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens
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
  for (const token of tokenizeSearchQuery(rawQuery.trim())) {
    const normalized = token.toLowerCase()
    if (normalized === 'is:issue') {
      if (query.scope === 'pr') {
        continue
      }
      query.scope = 'issue'
      continue
    }
    if (normalized === 'is:pr') {
      query.scope = query.scope === 'issue' ? 'all' : 'pr'
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
      freeTextTokens.push(token)
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

    freeTextTokens.push(token)
  }

  query.freeText = freeTextTokens.join(' ').trim()
  return query
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
