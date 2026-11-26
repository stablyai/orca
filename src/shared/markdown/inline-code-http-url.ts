/** A code span supplies both URL boundaries, so parentheses and trailing punctuation can be literal. */
export function isInlineCodeHttpUrl(value: string): boolean {
  return (
    /^https?:\/\/[^/?#]/i.test(value) && !/[\s\p{Cc}\\<>"`{}]/u.test(value) && URL.canParse(value)
  )
}
