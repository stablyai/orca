// Spaces, dashes, slashes and dots read alike, so "anthropic/claude", "claude sonnet" and "gpt5" all find a model.
const SEPARATORS = /[\s\-_/.:]+/g

/** A model search's test of one model's id, label and description, or null for an empty search. */
export function nativeChatModelSearchMatcher(
  query: string
): ((fields: readonly string[]) => boolean) | null {
  const terms = query.toLowerCase().split(SEPARATORS).filter(Boolean)
  if (terms.length === 0) {
    return null
  }
  return (fields) => {
    // Why: NUL between fields, so a term never matches across two of them.
    const haystack = fields.join('\u0000').toLowerCase().replace(SEPARATORS, '')
    return terms.every((term) => haystack.includes(term))
  }
}
