import { useLayoutEffect, useState } from 'react'

type Entry = { read: () => unknown; last: unknown }

// Committed root selectors only, keyed by a per-hook token so the hook never mutates its own state.
const committed = new Map<object, Entry>()
// Leading edge, at most once per interval, a bounded slice per pass: costs stay flat as mounted selectors grow,
// and successive passes walk the whole registry.
const CHECK_INTERVAL_MS = 1000
const CHECK_BUDGET = 200
let nextCheckAt = 0
let cursor: Iterator<Entry> | null = null

/** Development only: records, at commit, what each mounted root selector showed. */
export function useRecordedRootSelection(read: () => unknown): void {
  const [token] = useState(() => ({}))
  // Commit time, not render: a render React discards must not replace what is on screen.
  useLayoutEffect(() => {
    committed.set(token, { read, last: read() })
    return () => {
      committed.delete(token)
    }
  })
}

function checkCommittedRootSelectors(): void {
  for (let checked = 0; checked < CHECK_BUDGET; checked++) {
    cursor ??= committed.values()
    const next = cursor.next()
    if (next.done) {
      cursor = null
      return
    }
    const entry = next.value
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

/** After a channel-only write skipped root selectors: any whose result moved read a channel field. */
export function checkSkippedRootSelectors(): void {
  const now = performance.now()
  if (now < nextCheckAt) {
    return
  }
  nextCheckAt = now + CHECK_INTERVAL_MS
  checkCommittedRootSelectors()
}
