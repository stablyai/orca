import { parseVaultQuery } from './ai-vault-session-filters'

// Mirrors the operator arm of the panel tokenizer so the same spellings the
// client-side filter accepts are the ones stripped from the index query text.
const QUERY_OPERATOR_PATTERN = /(?:repo|path):(?:"[^"]*"|'[^']*'|\S*)/gi

export type AiVaultSearchQuerySplit = {
  /** Free text sent to the index; operator terms removed. */
  text: string
  repoTerms: readonly string[]
  pathTerms: readonly string[]
}

/**
 * Splits `repo:` / `path:` operators out of a search query. Lives in /shared so
 * the renderer, the index query path, and any raw RPC caller all read one
 * spelling of the operators instead of each growing its own parser.
 */
export function splitAiVaultSearchQuery(query: string): AiVaultSearchQuerySplit {
  const parsed = parseVaultQuery(query)
  return {
    text: query.replaceAll(QUERY_OPERATOR_PATTERN, ' ').replace(/\s+/g, ' ').trim(),
    repoTerms: parsed.repoTerms,
    pathTerms: parsed.pathTerms
  }
}

export function hasAiVaultSearchQueryOperators(split: AiVaultSearchQuerySplit): boolean {
  return split.repoTerms.length > 0 || split.pathTerms.length > 0
}
