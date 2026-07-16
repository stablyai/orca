import {
  hasIdentifierTransitionMatchBeforeSeparator,
  isPathSeparator
} from './quick-open-word-boundaries'

export type QuickOpenMatchCandidate = {
  lowerPath: string
  lowerFilename: string
  wordStarts: Uint8Array
}

export type PreparedQuickOpenQuery = {
  normalized: string
  /** Query with ` `/`_`/`-` stripped; null when the query has none of them. */
  compactFilename: string | null
  hasIdentifierSeparator: boolean
}

export function prepareQuickOpenQuery(normalized: string): PreparedQuickOpenQuery {
  // Why: spaces, hyphens, and underscores are equivalent human separators, so
  // camelCase basenames earn the filename boost for all three query styles.
  return {
    normalized,
    compactFilename: /[ _-]/.test(normalized) ? normalized.replace(/[ _-]/g, '') : null,
    hasIdentifierSeparator: normalized.includes('_') || normalized.includes('-')
  }
}

/**
 * Fuzzy subsequence match with VS Code-like word separators:
 * - Spaces in the query match path separators (`_`, `-`, `/`, `.`) or a
 *   zero-width camelCase / word boundary.
 * - Hyphens and underscores are interchangeable identifier separators.
 * - Word-start hits score better so basename/token starts rank above distant
 *   character soup.
 */
export function fuzzyMatchIndexedFile(
  query: PreparedQuickOpenQuery,
  file: QuickOpenMatchCandidate
): number | null {
  let score = matchQueryFromAnchor(query.normalized, file, -1)
  if (query.compactFilename !== null) {
    // Why: greedy matching can anchor query tokens in a same-named ancestor
    // directory (user-profile vs user/UserProfile/index.tsx, or
    // tab_bar_create_entry vs tab-bar/TabBarCreateEntry.tsx) and then dead-end
    // at the next '/'. Re-anchor at segment boundaries so each candidate competes
    // from its best interpretation, whether the meaningful name is the basename
    // or an inner directory. The optimal anchor for any match is the '/' just
    // before the first matched char, so only segments that actually contain a
    // first-char match are worth re-anchoring; that keeps this bounded on deep
    // 100k-file paths. Plain queries skip this to preserve the previous scorer's
    // whole-path-only ranking.
    const path = file.lowerPath
    const first = query.normalized[0]
    let slashIdx = -1
    let segmentMatched = false
    for (let i = 0; i < path.length; i++) {
      if (path[i] === '/') {
        slashIdx = i
        segmentMatched = false
        continue
      }
      if (!segmentMatched && slashIdx !== -1 && searchCharactersMatch(path[i], first)) {
        segmentMatched = true
        const anchoredScore = matchQueryFromAnchor(query.normalized, file, slashIdx)
        if (anchoredScore !== null && (score === null || anchoredScore < score)) {
          score = anchoredScore
        }
      }
    }
  }
  if (score === null) {
    return null
  }

  // Filename substring boost: allow human separators to hit equivalent names
  // (`product detail` / `product-detail` → product_detail.dart).
  if (filenameMatchesQuery(file.lowerFilename, query)) {
    score -= 100
  }

  return score
}

function matchQueryFromAnchor(
  query: string,
  file: QuickOpenMatchCandidate,
  anchorIndex: number
): number | null {
  const path = file.lowerPath
  const wordStarts = file.wordStarts
  let qi = 0
  let score = 0
  let lastMatchIdx = anchorIndex
  let hasMatchedChar = false
  let requireWordStart = false

  while (qi < query.length) {
    if (query[qi] === ' ') {
      qi++
      // Trailing space should not occur after normalize, but stay safe.
      if (qi >= query.length) {
        break
      }

      const nextIdx = lastMatchIdx + 1
      if (nextIdx < path.length && isPathSeparator(path[nextIdx])) {
        // Separator runs are a single conceptual word break for spaced queries.
        score -= 5
        let sepIdx = nextIdx
        while (sepIdx + 1 < path.length && isPathSeparator(path[sepIdx + 1])) {
          sepIdx++
        }
        lastMatchIdx = sepIdx
        requireWordStart = false
      } else {
        // Why: "Product Detail" vs ProductDetail — no separator char, only a
        // camelCase boundary. Force the next letter onto a word start.
        requireWordStart = true
      }
      continue
    }

    if (
      isIdentifierSeparator(query[qi]) &&
      qi + 1 < query.length &&
      hasMatchedChar &&
      hasIdentifierTransitionMatchBeforeSeparator(path, wordStarts, lastMatchIdx + 1, query[qi + 1])
    ) {
      // Why: typed separators also bridge zero-width case transitions. Rank
      // literal (0) < swapped separator (+1) < case transition (+2) so the
      // order stays deterministic regardless of the filename boost.
      score += 2
      qi++
      requireWordStart = true
      continue
    }

    const wanted = query[qi]
    let matched = false
    for (let ti = lastMatchIdx + 1; ti < path.length; ti++) {
      if (!searchCharactersMatch(path[ti], wanted)) {
        continue
      }
      if (requireWordStart && wordStarts[ti] !== 1) {
        continue
      }

      const gap = lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
      score += gap
      // Why: equivalent separators should match, but the literally typed form
      // should rank first when both filename variants exist.
      if (path[ti] !== wanted) {
        score++
      }
      // Why: skip path index 0 so a leading `s` in `src/...` stays score 0
      // (previous scorer only bonused matches after `/` `.` `-`).
      if (ti > 0 && wordStarts[ti] === 1) {
        score -= 5
      }
      lastMatchIdx = ti
      qi++
      hasMatchedChar = true
      requireWordStart = false
      matched = true
      break
    }

    if (!matched) {
      // Why: a trailing separator mid-typing ("product-") must not blank out
      // results that a trailing space would keep; literal was tried above.
      if (isIdentifierSeparator(wanted) && qi === query.length - 1 && hasMatchedChar) {
        score += 2
        qi++
        continue
      }
      return null
    }
  }

  return score
}

function filenameMatchesQuery(lowerFilename: string, query: PreparedQuickOpenQuery): boolean {
  if (
    lowerFilename.includes(query.normalized) ||
    (query.hasIdentifierSeparator &&
      includesWithIdentifierSeparatorEquivalence(lowerFilename, query.normalized))
  ) {
    return true
  }
  if (!query.compactFilename) {
    return false
  }
  // Why: users type words with spaces; basenames use `_` / `-` / camelCase.
  return includesIgnoringSeparators(lowerFilename, query.compactFilename)
}

function includesWithIdentifierSeparatorEquivalence(value: string, wanted: string): boolean {
  const lastStart = value.length - wanted.length
  for (let start = 0; start <= lastStart; start++) {
    let offset = 0
    while (offset < wanted.length && searchCharactersMatch(value[start + offset], wanted[offset])) {
      offset++
    }
    if (offset === wanted.length) {
      return true
    }
  }
  return false
}

function includesIgnoringSeparators(value: string, wanted: string): boolean {
  for (let start = 0; start < value.length; start++) {
    if (value[start] !== wanted[0]) {
      continue
    }
    let valueIndex = start
    let wantedIndex = 0
    while (valueIndex < value.length && wantedIndex < wanted.length) {
      const ch = value[valueIndex]
      // Why: skip only a value separator we aren't currently matching, so an
      // extension dot in the query ("product-detail.dart") still lands on the
      // basename's dot instead of being skipped past into a dead-end.
      if (isPathSeparator(ch) && ch !== wanted[wantedIndex]) {
        valueIndex++
        continue
      }
      if (ch !== wanted[wantedIndex]) {
        break
      }
      valueIndex++
      wantedIndex++
    }
    if (wantedIndex === wanted.length) {
      return true
    }
  }
  return false
}

function searchCharactersMatch(valueChar: string, queryChar: string): boolean {
  // Why: `-`/`_`/space are equivalent human separators, so a typed identifier
  // separator also matches a literal space in a filename ("Meeting Notes.md").
  // `/` and `.` stay distinct so path/extension boundaries aren't crossed.
  return (
    valueChar === queryChar ||
    (isIdentifierSeparator(queryChar) &&
      (isIdentifierSeparator(valueChar) || valueChar === ' '))
  )
}

function isIdentifierSeparator(ch: string): boolean {
  return ch === '_' || ch === '-'
}
