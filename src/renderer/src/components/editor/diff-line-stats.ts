/**
 * Compute approximate added/removed line counts by matching lines between
 * original and modified content using a multiset approach.
 */
export function computeLineStats(
  original: string,
  modified: string,
  status: string
): { added: number; removed: number } | null {
  // Why: for very large files, splitting in React render would block the UI.
  if (original.length + modified.length > 500_000) {
    return null
  }
  if (status === 'added') {
    return { added: modified ? modified.split('\n').length : 0, removed: 0 }
  }
  if (status === 'deleted') {
    return { added: 0, removed: original ? original.split('\n').length : 0 }
  }

  const origLines = original.split('\n')
  const modLines = modified.split('\n')
  const origMap = new Map<string, number>()
  for (const line of origLines) {
    origMap.set(line, (origMap.get(line) ?? 0) + 1)
  }

  let matched = 0
  for (const line of modLines) {
    const count = origMap.get(line) ?? 0
    if (count > 0) {
      origMap.set(line, count - 1)
      matched++
    }
  }

  return {
    added: modLines.length - matched,
    removed: origLines.length - matched
  }
}
