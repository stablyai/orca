export function isPathSeparator(ch: string): boolean {
  return ch === '/' || ch === '_' || ch === '-' || ch === '.' || ch === ' '
}

export function hasIdentifierTransitionMatchBeforeSeparator(
  path: string,
  wordStarts: Uint8Array,
  startIndex: number,
  wanted: string
): boolean {
  for (let index = startIndex; index < path.length; index++) {
    if (isPathSeparator(path[index])) {
      return false
    }
    // Why: a typed `-`/`_` bridges only a zero-width case transition, never a
    // real separator. When a preceding query space consumed a `/` or `.` run,
    // startIndex sits on the char after it — a word start induced by that
    // separator, not a camelCase change — so require the prior char to be a
    // non-separator (a genuine intra-word boundary like ProductDetail/APIClient).
    if (
      wordStarts[index] === 1 &&
      path[index] === wanted &&
      (index === 0 || !isPathSeparator(path[index - 1]))
    ) {
      return true
    }
  }
  return false
}
