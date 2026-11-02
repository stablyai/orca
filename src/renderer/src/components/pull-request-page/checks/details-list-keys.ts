/** Content plus occurrence disambiguates duplicate annotations/null-ID jobs without index-only keys reshuffling unrelated rows. */
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
