// Spaces, dashes, slashes and dots inside a word read alike, so "anthropic/claude" and "gpt5" find their model.
const SEPARATORS = /[\s\-_/.:]+/g
// Between two digits a separator stays one mark, so "4.5" finds "4-5" but "5.1" never joins "4-20250514".
const BETWEEN_DIGITS = /(\d)[\s\-_/.:]+(?=\d)/g

function normalize(text: string): string {
  return text.toLowerCase().replace(BETWEEN_DIGITS, '$1\u0001').replace(SEPARATORS, '')
}

/** A model's id, label and description as one searchable string. */
export function nativeChatModelSearchText(fields: readonly string[]): string {
  // Why: NUL between fields, so a term never matches across two of them.
  return normalize(fields.join('\u0000'))
}

/** A model search's test of `nativeChatModelSearchText`, or null for an empty search. */
export function nativeChatModelSearchMatcher(query: string): ((text: string) => boolean) | null {
  // Words split only on spaces, so "gpt-5.5" stays one term and never matches gpt-5.6.
  const terms = query.split(/\s+/).map(normalize).filter(Boolean)
  if (terms.length === 0) {
    return null
  }
  return (text) => terms.every((term) => text.includes(term))
}
