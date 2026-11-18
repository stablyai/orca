import { useCallback, useEffect, useState } from 'react'

type Entry = { read: () => unknown; last: unknown }

const entries = new Set<Entry>()

/** Development only: records what each mounted root selector last returned to React. */
export function useRecordedRootSelection<U>(read: () => U): () => U {
  const [entry] = useState<Entry>(() => ({ read, last: undefined }))
  useEffect(() => {
    entries.add(entry)
    return () => {
      entries.delete(entry)
    }
  }, [entry])
  return useCallback(() => {
    const value = read()
    entry.read = read
    entry.last = value
    return value
  }, [read, entry])
}

/** After a channel-only write skipped root selectors: any whose result moved read a channel field. */
export function checkSkippedRootSelectors(): void {
  for (const entry of Array.from(entries)) {
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
