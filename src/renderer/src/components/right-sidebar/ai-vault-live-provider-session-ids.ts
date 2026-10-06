// Status writes replace the map, so index each immutable snapshot once.
let keysBySnapshot = new WeakMap<object, string>()

export function resetAiVaultLiveProviderSessionIdsForTest(): void {
  keysBySnapshot = new WeakMap<object, string>()
}

export function getAiVaultLiveProviderSessionIdsKey(
  entries: Record<string, { providerSession?: { id?: string } | null }> | undefined
): string {
  if (!entries) {
    return ''
  }
  const cached = keysBySnapshot.get(entries)
  if (cached !== undefined) {
    return cached
  }
  const ids: string[] = []
  for (const entry of Object.values(entries)) {
    if (entry.providerSession?.id) {
      ids.push(entry.providerSession.id)
    }
  }
  const key = ids.sort().join('\n')
  keysBySnapshot.set(entries, key)
  return key
}

export function recordAiVaultLiveProviderSessionIds(
  key: string,
  seen: Set<string> | null
): { seen: Set<string>; added: boolean } {
  const ids = key === '' ? [] : key.split('\n')
  if (seen === null) {
    return { seen: new Set(ids), added: false }
  }
  let added = false
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id)
      added = true
    }
  }
  return { seen, added }
}
