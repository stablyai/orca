// Why: the middle band and the project band scored queries with byte-identical copies of
// this logic, so ranking fixes only ever landed in one of the two.

function isCmdJPaletteWhitespace(code: number): boolean {
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

// Why: iterating code units would lowercase surrogate halves separately, leaving
// supplementary-plane characters uncased and unmatchable.
export function normalizeCmdJPaletteQuery(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (const character of value) {
    if (isCmdJPaletteWhitespace(character.codePointAt(0) ?? 0)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += character.toLowerCase()
  }
  return normalized
}

export function uniqueNormalizedCmdJPaletteKeywords(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeCmdJPaletteQuery).filter(Boolean))]
}

// Why: splitting on non-ASCII would drop CJK and accented words entirely, so a localized
// query would silently skip the coverage rule below instead of failing it.
export function tokenizeCmdJPaletteQuery(value: string): string[] {
  return normalizeCmdJPaletteQuery(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

// Why: navigation filler carries no intent ("open ssh settings" means "ssh settings"), so an
// unmatched filler word must not count against a candidate's coverage.
const CMD_J_QUERY_FILLER_TOKENS = new Set([
  'a',
  'an',
  'and',
  'change',
  'edit',
  'for',
  'from',
  'go',
  'goto',
  'in',
  'into',
  'jump',
  'me',
  'my',
  'of',
  'on',
  'open',
  'please',
  'set',
  'show',
  'the',
  'to',
  'view',
  'with'
])

export function cmdJPaletteTokenScore(query: string, values: readonly string[]): number {
  const candidateTokens = values.flatMap(tokenizeCmdJPaletteQuery)
  if (candidateTokens.length === 0) {
    return 0
  }

  let score = 0
  let meaningful = 0
  let covered = 0
  for (const queryToken of tokenizeCmdJPaletteQuery(query)) {
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
    score += best
    if (CMD_J_QUERY_FILLER_TOKENS.has(queryToken)) {
      continue
    }
    meaningful += 1
    if (best > 0) {
      covered += 1
    }
  }

  // Why: "linear triage" matched the Linear pane as strongly as "linear" did, so a candidate
  // now has to cover most of what was typed, not just one word of it.
  if (meaningful > 0 && covered * 2 <= meaningful) {
    return 0
  }
  return score
}
