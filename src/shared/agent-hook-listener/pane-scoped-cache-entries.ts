// Why keyed this way: a pane's caches are stored under its pane key and under `<paneKey>\0<suffix>`
// sub-keys, so moving or deleting a pane must take both.

export function movePaneScopedMapEntries<T>(
  map: Map<string, T>,
  fromPaneKey: string,
  toPaneKey: string
): void {
  for (const [key, value] of Array.from(map.entries())) {
    if (key !== fromPaneKey && !key.startsWith(`${fromPaneKey}\0`)) {
      continue
    }
    map.delete(key)
    map.set(`${toPaneKey}${key.slice(fromPaneKey.length)}`, value)
  }
}

export function movePaneScopedSetEntries(
  set: Set<string>,
  fromPaneKey: string,
  toPaneKey: string
): void {
  for (const key of Array.from(set)) {
    if (key !== fromPaneKey && !key.startsWith(`${fromPaneKey}\0`)) {
      continue
    }
    set.delete(key)
    set.add(`${toPaneKey}${key.slice(fromPaneKey.length)}`)
  }
}

export function deletePaneScopedCacheEntry(map: Map<string, unknown>, paneKey: string): void {
  map.delete(paneKey)
  const scopedPrefix = `${paneKey}\0`
  for (const key of map.keys()) {
    if (key.startsWith(scopedPrefix)) {
      map.delete(key)
    }
  }
}

export function deletePaneScopedSetEntry(set: Set<string>, paneKey: string): void {
  set.delete(paneKey)
  const scopedPrefix = `${paneKey}\0`
  for (const key of set) {
    if (key.startsWith(scopedPrefix)) {
      set.delete(key)
    }
  }
}
