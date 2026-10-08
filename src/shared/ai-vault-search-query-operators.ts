/** Anchored at a token start only, so `myrepo:x` and `https://h/path:x` stay literal. */
const OPERATOR = /(repo|path):/iy

export type AiVaultSearchQuerySplit = {
  /** Query minus the operator tokens, quoting intact; what FTS sees. */
  text: string
  /** The same free text as tokens with quotes stripped; what a substring matcher wants. */
  terms: readonly string[]
  /** Operator values as typed apart from surrounding space: the panel folds case, the index does not. */
  repoTerms: readonly string[]
  pathTerms: readonly string[]
}

/**
 * The one reading of `repo:` / `path:` in the product: the sessions panel and the
 * search index must agree on what is an operator and what is ordinary text.
 */
export function splitAiVaultSearchQuery(query: string): AiVaultSearchQuerySplit {
  const spans: string[] = []
  const terms: string[] = []
  const repoTerms: string[] = []
  const pathTerms: string[] = []
  let index = 0
  while (index < query.length) {
    if (isBoundary(query[index])) {
      index += 1
      continue
    }
    OPERATOR.lastIndex = index
    const operator = OPERATOR.exec(query)
    if (operator) {
      const at = index + operator[0].length
      const quoted = readQuoted(query, at)
      const value = quoted?.value ?? readBare(query, at)
      index = quoted ? quoted.end : at + value.length
      // Trimmed for the same reason an empty value is dropped: `repo:"  "` is
      // not a narrowing anyone typed on purpose, and an untrimmed one matches
      // no label at all, which silently empties the list.
      const operand = value.trim()
      if (operand) {
        ;(operator[1]!.toLowerCase() === 'repo' ? repoTerms : pathTerms).push(operand)
      }
      continue
    }
    const quoted = readQuoted(query, index)
    const value = quoted?.value ?? readBare(query, index)
    const end = quoted ? quoted.end : index + value.length
    spans.push(query.slice(index, end))
    // The span keeps the query verbatim for FTS; only the substring matcher's
    // copy is trimmed, so `"  "` reads as the empty term `""` already does
    // rather than as a term no session's text contains.
    terms.push(value.trim())
    index = end
  }
  return { text: spans.join(' '), terms, repoTerms, pathTerms }
}

export function hasAiVaultSearchQueryOperators(split: AiVaultSearchQuerySplit): boolean {
  return split.repoTerms.length > 0 || split.pathTerms.length > 0
}

function isBoundary(char: string | undefined): boolean {
  return char === undefined || /\s/.test(char)
}

/**
 * A quoted span, or null when this is not one.
 *
 * What keeps the apostrophes in `it's a repo:orca thing's` from opening a span
 * that swallows the operator is the caller: this only ever runs at a token
 * start, and the quote in `it's` is not at one. The closing quote is then just
 * the next one, wherever it falls, so `"a b"c` reads as the panel has always
 * read it — the span, then the rest as its own token.
 */
function readQuoted(query: string, at: number): { value: string; end: number } | null {
  const quote = query[at]
  if (quote !== '"' && quote !== "'") {
    return null
  }
  const close = query.indexOf(quote, at + 1)
  return close === -1 ? null : { value: query.slice(at + 1, close), end: close + 1 }
}

function readBare(query: string, at: number): string {
  let end = at
  while (end < query.length && !isBoundary(query[end])) {
    end += 1
  }
  return query.slice(at, end)
}
