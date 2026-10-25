import { normalizePaletteText } from '@/lib/palette-match/normalized-text'
import { PALETTE_QUERY_MAX_TOKENS } from '@/lib/palette-match/palette-query'

// Unicode spaces are already folded; only ASCII control whitespace remains to collapse.
function isCmdJPaletteWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

// Reuse shared Unicode/case folding across sections; collapse runs locally without regex over untrusted input.
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

// Count unique whitespace tokens like entity sections before bounding the punctuation-split scoring tokens separately.
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
  // Punctuation can expand one pasted token into hundreds; bound that per-candidate scoring cost too.
  return uniqueCmdJPaletteQueryTokens(normalizedQuery).length > PALETTE_QUERY_MAX_TOKENS
}

/** Deduplicate query tokens so repeated words cannot inflate a candidate’s score. */
export function uniqueCmdJPaletteQueryTokens(query: string): string[] {
  return [...new Set(tokenizeCmdJPaletteQuery(query))]
}

export function uniqueNormalizedCmdJPaletteKeywords(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeCmdJPaletteQuery).filter(Boolean))]
}

// Keep Unicode words so localized queries cannot silently bypass coverage requirements.
export function tokenizeCmdJPaletteQuery(value: string): string[] {
  return normalizeCmdJPaletteQuery(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

// Reverse containment serves unsegmented Han/Kana/Hangul; Latin substring coincidences such as database/base must not score.
const UNSEGMENTED_SCRIPT_TOKEN_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

function isUnsegmentedScriptToken(token: string): boolean {
  return UNSEGMENTED_SCRIPT_TOKEN_RE.test(token)
}

// Ignore unmatched navigation filler such as “open” when measuring intent coverage.
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

// Tokenize once per query; repeating folding/splitting for every candidate dominates ranking cost.
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
        // Unsegmented scripts need weak reverse containment: 终端设置 contains the 终端 keyword.
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

  // Require majority coverage so a single matching word cannot dominate a multiword query.
  if (meaningful > 0 && covered * 2 <= meaningful) {
    return 0
  }
  return score
}
