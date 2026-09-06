const QUERY_OPERATOR_PATTERN = /"[^"]*"|'[^']*'|(^|\s)(repo|path):(?:"([^"]*)"|'([^']*)'|(\S*))/gi

export type AiVaultSearchQuerySplit = {
  text: string
  repoTerms: readonly string[]
  pathTerms: readonly string[]
}

/** Preserve path spelling and remove only complete operator tokens. */
export function splitAiVaultSearchQuery(query: string): AiVaultSearchQuerySplit {
  const repoTerms: string[] = []
  const pathTerms: string[] = []
  const text = query
    .replaceAll(
      QUERY_OPERATOR_PATTERN,
      (
        _match,
        space: string,
        operator: string | undefined,
        doubleQuoted: string | undefined,
        singleQuoted: string | undefined,
        bare: string | undefined
      ) => {
        if (!operator) {
          return _match
        }
        const value = doubleQuoted ?? singleQuoted ?? bare ?? ''
        if (value) {
          if (operator.toLowerCase() === 'repo') {
            repoTerms.push(value.toLowerCase())
          } else {
            pathTerms.push(value)
          }
        }
        return space
      }
    )
    .replace(/\s+/g, ' ')
    .trim()
  return { text, repoTerms, pathTerms }
}

export function hasAiVaultSearchQueryOperators(split: AiVaultSearchQuerySplit): boolean {
  return split.repoTerms.length > 0 || split.pathTerms.length > 0
}
