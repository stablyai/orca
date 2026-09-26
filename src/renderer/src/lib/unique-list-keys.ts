/**
 * Stable React keys for lists whose items carry no id of their own. Keying on
 * content alone collides when items repeat; keying on the array index reshuffles
 * rows on every list update. Pairing the content key with its occurrence count
 * gives both a stable and a unique key.
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
