// Spaces, dashes, slashes and dots inside a word read alike, so "anthropic/claude" and "gpt5" find their model.
const SEPARATORS = /[\s\-_/.:]+/g

/** A model's id, label and description as one searchable string. */
export function nativeChatModelSearchText(fields: readonly string[]): string {
  // Why: NUL between fields, so a term never matches across two of them.
  return fields.join('\u0000').toLowerCase().replace(SEPARATORS, '')
}

/** A model search's test of `nativeChatModelSearchText`, or null for an empty search. */
export function nativeChatModelSearchMatcher(query: string): ((text: string) => boolean) | null {
  // Words split only on spaces, so "gpt-5.5" stays one term and never matches gpt-5.6.
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(SEPARATORS, ''))
    .filter(Boolean)
  if (terms.length === 0) {
    return null
  }
  return (text) => terms.every((term) => text.includes(term))
}
