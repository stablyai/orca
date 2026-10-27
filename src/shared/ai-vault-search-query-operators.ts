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

/** Share repo/path parsing between panel filtering and indexed search so operators retain one meaning. */
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
      // Trim whitespace-only operators like empty values; matching spaces as a label silently empties results.
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
    // Preserve verbatim spans for FTS; trim substring tokens so whitespace-only quotes behave as empty terms.
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

/** Called only at token starts so interior apostrophes cannot swallow operators. Close at the next quote, even mid-word; the remainder becomes its own token. */
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
