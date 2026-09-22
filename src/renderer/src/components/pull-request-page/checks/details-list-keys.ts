/**
 * Check annotations and jobs carry no stable id of their own: GitHub workflow-level annotations
 * repeat identical content (`path`/`startLine` null, same message), and GitLab jobs may report a
 * null id. Keying on content alone therefore collides; keying on the array index alone reshuffles
 * rows on every list update. Pairing the content key with its occurrence count gives both.
 */
export function assignUniqueListKeys<T>(
  items: readonly T[],
  contentKey: (item: T) => string
): { item: T; key: string }[] {
  const occurrences = new Map<string, number>()
  return items.map((item) => {
    const base = contentKey(item)
    const seen = occurrences.get(base) ?? 0
    occurrences.set(base, seen + 1)
    // JSON-encoded pair, not `base#seen`: a separator suffix would collide with a real content key.
    return { item, key: JSON.stringify([base, seen]) }
  })
}
