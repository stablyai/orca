import { useCallback, useEffect, useState } from 'react'

type Entry = { read: () => unknown; last: unknown }

// Keyed by a per-hook token so the hook never mutates its own state.
const records = new WeakMap<object, Entry>()
const mounted = new Set<object>()

/** Development only: records what each mounted root selector last returned to React. */
export function useRecordedRootSelection<U>(read: () => U): () => U {
  const [token] = useState(() => ({}))
  useEffect(() => {
    mounted.add(token)
    return () => {
      mounted.delete(token)
    }
  }, [token])
  return useCallback(() => {
    const value = read()
    records.set(token, { read, last: value })
    return value
  }, [read, token])
}

/** After a channel-only write skipped root selectors: any whose result moved read a channel field. */
export function checkSkippedRootSelectors(): void {
  for (const token of Array.from(mounted)) {
    const entry = records.get(token)
    if (!entry) {
      continue
    }
    let value: unknown
    try {
      value = entry.read()
    } catch {
      continue
    }
    if (!Object.is(value, entry.last)) {
      entry.last = value
      console.error(
        'A root app-store selector changed on a channel-only write; read channel fields through useAppStoreWithChannels.',
        entry.read
      )
    }
  }
}
