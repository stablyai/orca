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
  retain?: Readonly<Record<string, number>>,
  getPendingSubjects?: () => ReadonlyMap<string, string>
): Record<string, number> {
  const entries = Object.entries(record)
  if (entries.length <= PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
    return record
  }
  const pendingSubjects = getPendingSubjects?.()
  let ranked = entries
  let heldSubjects: ReadonlySet<string> | undefined
  if (pendingSubjects?.size) {
    const subjects = new Map<string, number>()
    for (const [key, at] of entries) {
      const subject = pendingSubjects.get(key) ?? key
      subjects.set(subject, Math.max(subjects.get(subject) ?? at, at))
    }
    if (subjects.size <= PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
      return record
    }
    ranked = [...subjects]
    if (retain) {
      heldSubjects = new Set(Object.keys(retain).map((key) => pendingSubjects.get(key) ?? key))
    }
  }
  const retained: [string, number][] = []
  let candidates = ranked
  if (retain) {
    candidates = []
    for (const entry of ranked) {
      const key = entry[0]
      const held = heldSubjects ? heldSubjects.has(key) : Object.hasOwn(retain, key)
      const group = held ? retained : candidates
      group.push(entry)
    }
  }
  const available = PANE_KEY_TIMESTAMP_MAX_ENTRIES - retained.length
  let newest: [string, number][] = []
  if (available > 0) {
    for (let offset = 0; offset < candidates.length; offset += PANE_KEY_TIMESTAMP_MAX_ENTRIES) {
      newest = newest
        .concat(candidates.slice(offset, offset + PANE_KEY_TIMESTAMP_MAX_ENTRIES))
        .sort(([, left], [, right]) => right - left)
        .slice(0, available)
    }
  }
  const selected = [...retained, ...newest]
  if (pendingSubjects) {
    const selectedSubjects = new Set(selected.map(([key]) => key))
    return Object.fromEntries(
      entries.filter(([key]) => pendingSubjects.has(key) || selectedSubjects.has(key))
    )
  }
  return Object.fromEntries(selected)
}
