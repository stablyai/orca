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
export function capPaneKeyTimestampRecord(record: Record<string, number>): Record<string, number> {
  const entries = Object.entries(record)
  if (entries.length <= PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
    return record
  }
  let newest: [string, number][] = []
  for (let offset = 0; offset < entries.length; offset += PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
    newest = newest
      .concat(entries.slice(offset, offset + PANE_KEY_TIMESTAMP_MAX_ENTRIES))
      .sort(([, left], [, right]) => right - left)
      .slice(0, PANE_KEY_TIMESTAMP_MAX_ENTRIES)
  }
  return Object.fromEntries(newest)
}
