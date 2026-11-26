/** A code span supplies both URL boundaries, so parentheses and trailing punctuation can be literal. */
export function isInlineCodeHttpUrl(value: string): boolean {
  if (!/^https?:\/\/[^/?#]/i.test(value) || /[\s\p{Cc}\\<>"`{}]/u.test(value)) {
    return false
  }
  try {
    return new URL(value).hostname.length > 0
  } catch {
    return false
  }
}
