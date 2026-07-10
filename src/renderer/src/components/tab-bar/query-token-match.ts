// Shared token matching for the new-tab open entry: the create-menu actions and
// the agent launch options both rank a query against a set of candidate strings.

export type QueryTokenMatch = {
  allTokensMatched: boolean
  score: number
}

export function normalizeMatchQuery(value: string): string {
  return foldMatchQueryWhitespace(value).toLowerCase()
}

// Why: tab-create queries can come from large pasted text; keep whitespace
// folding linear without whole-string regex replacement.
function foldMatchQueryWhitespace(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isMatchQueryWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index)
  }
  return normalized
}

function isMatchQueryWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
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
