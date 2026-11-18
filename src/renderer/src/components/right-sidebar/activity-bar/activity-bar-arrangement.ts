export function arrangeActivityItems<T extends { id: string; pluginKey?: string }>(
  items: T[],
  order: string[]
): T[] {
  const byId = new Map(items.map((item) => [item.id, item]))
  const result: T[] = []
  for (const id of order) {
    const item = byId.get(id)
    if (item) {
      result.push(item)
      byId.delete(id)
    }
  }
  const savedBuiltins = new Set(result.filter((item) => !item.pluginKey).map((item) => item.id))
  let anchor: T | undefined
  let insertionTail: T | undefined
  for (const item of items) {
    if (item.pluginKey) {
      continue
    }
    if (savedBuiltins.has(item.id)) {
      anchor = item
      insertionTail = undefined
      continue
    }
    if (byId.has(item.id)) {
      // Only saved built-ins anchor new built-ins; preserve all saved relative positions.
      const previous = insertionTail ?? anchor
      const firstSavedBuiltin = result.findIndex((entry) => savedBuiltins.has(entry.id))
      const firstPlugin = result.findIndex((entry) => entry.pluginKey)
      const index = previous
        ? result.indexOf(previous) + 1
        : firstSavedBuiltin !== -1
          ? firstSavedBuiltin
          : firstPlugin !== -1
            ? firstPlugin
            : result.length
      result.splice(index, 0, item)
      byId.delete(item.id)
      insertionTail = item
    }
  }
  return [...result, ...byId.values()]
}

export function mergeActivityOrder(saved: string[], reordered: string[]): string[] {
  const available = new Set(reordered)
  const slots = [...new Set([...saved, ...reordered])]
  let index = 0
  return slots.map((id) => (available.has(id) ? reordered[index++] : id))
}
