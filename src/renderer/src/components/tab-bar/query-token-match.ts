// Shared token matching for the new-tab open entry: the create-menu actions and
// the agent launch options both rank a query against a set of candidate strings.

export type QueryTokenMatch = {
  allTokensMatched: boolean
  score: number
}

export function normalizeMatchQuery(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function tokenizeMatchValue(value: string): string[] {
  return normalizeMatchQuery(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

// Scores each query token against the best-matching candidate token: an exact
// token wins over a prefix, which wins over a mid-string substring.
export function scoreQueryTokens(query: string, values: readonly string[]): QueryTokenMatch {
  const candidateTokens = values.flatMap(tokenizeMatchValue)
  if (candidateTokens.length === 0) {
    return { allTokensMatched: false, score: 0 }
  }

  const queryTokens = tokenizeMatchValue(query)
  if (queryTokens.length === 0) {
    return { allTokensMatched: false, score: 0 }
  }

  let score = 0
  let allTokensMatched = true
  for (const queryToken of queryTokens) {
    let best = 0
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) {
        best = Math.max(best, 3)
      } else if (candidateToken.startsWith(queryToken)) {
        best = Math.max(best, 2)
      } else if (candidateToken.includes(queryToken)) {
        best = Math.max(best, 1)
      }
    }
    if (best === 0) {
      allTokensMatched = false
    }
    score += best
  }
  return { allTokensMatched, score }
}
