// Why: the middle band and the project band scored queries with byte-identical copies of
// this logic, so ranking fixes only ever landed in one of the two.

import { normalizePaletteText } from '@/lib/palette-match/normalized-text'
import { PALETTE_QUERY_MAX_TOKENS } from '@/lib/palette-match/palette-query'

// Why: normalizePaletteText already folds every Unicode space to U+0020, so only ASCII
// control whitespace can still reach the collapsing pass below.
function isCmdJPaletteWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

// Why: one Cmd+J query must fold identically in every section, so case/Unicode folding comes
// from the shared matcher and only run collapsing (which entity tokens skip) stays local.
// The collapse avoids a regex over untrusted pasted text.
export function normalizeCmdJPaletteQuery(value: string): string {
  const folded = normalizePaletteText(value).normalized
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < folded.length; index += 1) {
    if (isCmdJPaletteWhitespace(folded.charCodeAt(index))) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += folded[index]
  }
  return normalized
}

// Why: the token ceiling is a query rule, not a section rule, so it counts whitespace-split
// unique tokens exactly like the shared preparer instead of this file's punctuation-stripping
// tokenizer, which would reject `08-13 1.4.182` far earlier than the entity sections do.
export function isCmdJPaletteQueryOverTokenLimit(normalizedQuery: string): boolean {
  const seen = new Set<string>()
  for (const token of normalizedQuery.split(' ')) {
    if (!token) {
      continue
    }
    seen.add(token)
    if (seen.size > PALETTE_QUERY_MAX_TOKENS) {
      return true
    }
  }
  // Why also bound the scoring split: whitespace-split counting lets 2KB of punctuation
  // through as a single token, and the scorer's tokenizer then expands it into hundreds —
  // paid once per candidate, per keystroke, on the render thread.
  return uniqueCmdJPaletteQueryTokens(normalizedQuery).length > PALETTE_QUERY_MAX_TOKENS
}

/**
 * Why dedupe: a repeated query token would otherwise contribute its score twice, so
 * `terminal terminal ssh` outranks an otherwise-tied candidate on the strength of the repeat.
 */
export function uniqueCmdJPaletteQueryTokens(query: string): string[] {
  return [...new Set(tokenizeCmdJPaletteQuery(query))]
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

// Why gate the reverse-containment tier on script: a space-delimited language already
// tokenizes its own compounds, so a contained Latin keyword is a coincidence (`database`
// vs `base`), while Han/Kana/Hangul text arrives as one run that must be matched inside.
const UNSEGMENTED_SCRIPT_TOKEN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

function isUnsegmentedScriptToken(token: string): boolean {
  return UNSEGMENTED_SCRIPT_TOKEN_RE.test(token)
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

// Why the caller passes tokens: this runs once per candidate, and re-folding plus
// re-splitting the same query for each one dominated the ranking pass.
export function cmdJPaletteTokenScore(
  queryTokens: readonly string[],
  values: readonly string[]
): number {
  const candidateTokens = values.flatMap(tokenizeCmdJPaletteQuery)
  if (candidateTokens.length === 0) {
    return 0
  }

  let score = 0
  let meaningful = 0
  let covered = 0
  for (const queryToken of queryTokens) {
    let best = 0
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) {
        best = Math.max(best, 3)
      } else if (candidateToken.startsWith(queryToken)) {
        best = Math.max(best, 2)
      } else if (candidateToken.includes(queryToken)) {
        best = Math.max(best, 1)
      } else if (
        candidateToken.length >= 2 &&
        queryToken.includes(candidateToken) &&
        isUnsegmentedScriptToken(candidateToken)
      ) {
        // Why the reverse direction: CJK is written without spaces, so the natural query for
        // the terminal settings pane is the single token `终端设置` — one token that CONTAINS
        // the keyword rather than being contained by it. Weakest tier, gated on the script
        // that needs it: in Latin text the query `database` does not mean the keyword `base`.
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
