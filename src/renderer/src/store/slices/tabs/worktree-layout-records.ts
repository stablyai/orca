export function rekeyWorktreeEntry<T>(
  map: Record<string, T> | undefined,
  oldWorktreeId: string,
  newWorktreeId: string,
  mapValue: (value: T) => T = (value) => value,
  mergeExisting = false
): Record<string, T> | undefined {
  if (!map || !(oldWorktreeId in map)) {
    return undefined
  }
  const next = { ...map }
  if (!mergeExisting || !(newWorktreeId in map)) {
    next[newWorktreeId] = mapValue(map[oldWorktreeId])
  }
  delete next[oldWorktreeId]
  return next
}

export function unionWorktreeLayoutRows<T extends { id: string }>(
  destination: T[],
  source: T[]
): T[] {
  const seen = new Set(destination.map((item) => item.id))
  return [
    ...destination,
    ...source.filter((item) => {
      if (seen.has(item.id)) {
        return false
      }
      seen.add(item.id)
      return true
    })
  ]
}
