/** Anchored at a token start only, so `myrepo:x` and `https://h/path:x` stay literal. */
const OPERATOR = /(repo|path):/iy

export type AiVaultSearchQuerySplit = {
  /** Query minus the operator tokens, quoting intact; what FTS sees. */
  text: string
  /** The same free text as tokens with quotes stripped; what a substring matcher wants. */
  terms: readonly string[]
  /** Operator values exactly as typed: the panel folds case, the index does not. */
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
      if (value) {
        ;(operator[1]!.toLowerCase() === 'repo' ? repoTerms : pathTerms).push(value)
      }
      continue
    }
    const quoted = readQuoted(query, index)
    const value = quoted?.value ?? readBare(query, index)
    const end = quoted ? quoted.end : index + value.length
    spans.push(query.slice(index, end))
    terms.push(value)
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
 * Why the closing quote must end a word: otherwise the apostrophes in
 * `it's a repo:orca thing's` open a span that swallows the operator between them.
 */
function readQuoted(query: string, at: number): { value: string; end: number } | null {
  const quote = query[at]
  if (quote !== '"' && quote !== "'") {
    return null
  }
  const close = query.indexOf(quote, at + 1)
  return close === -1 || !isBoundary(query[close + 1])
    ? null
    : { value: query.slice(at + 1, close), end: close + 1 }
}

function readBare(query: string, at: number): string {
  let end = at
  while (end < query.length && !isBoundary(query[end])) {
    end += 1
  }
  return query.slice(at, end)
}
