const PANE_KEY_TIMESTAMP_MAX_ENTRIES = 500

export function isSafePersistedRecordKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

export function readPaneKeyTimestampRecord(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, number> = {}
  for (const [key, at] of Object.entries(value)) {
    if (isSafePersistedRecordKey(key) && typeof at === 'number' && Number.isFinite(at) && at > 0) {
      out[key] = at
    }
  }
  return out
}

// Bound the sort even for profiles with oversized pre-migration maps.
export function capPaneKeyTimestampRecord(
  record: Record<string, number>,
  retain?: Readonly<Record<string, number>>
): Record<string, number> {
  const entries = Object.entries(record)
  if (entries.length <= PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
    return record
  }
  const retained: [string, number][] = []
  let candidates = entries
  if (retain) {
    candidates = []
    for (const entry of entries) {
      const group = Object.hasOwn(retain, entry[0]) ? retained : candidates
      group.push(entry)
    }
  }
  const available = PANE_KEY_TIMESTAMP_MAX_ENTRIES - retained.length
  if (available <= 0) {
    return Object.fromEntries(retained)
  }
  let newest: [string, number][] = []
  for (let offset = 0; offset < candidates.length; offset += PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
    newest = newest
      .concat(candidates.slice(offset, offset + PANE_KEY_TIMESTAMP_MAX_ENTRIES))
      .sort(([, left], [, right]) => right - left)
      .slice(0, available)
  }
  return Object.fromEntries([...retained, ...newest])
}
