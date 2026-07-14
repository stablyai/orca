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
    if (wordStarts[index] === 1 && path[index] === wanted) {
      return true
    }
  }
  return false
}
