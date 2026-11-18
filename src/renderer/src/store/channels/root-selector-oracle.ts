import { useLayoutEffect, useState } from 'react'

type Entry = { read: () => unknown; last: unknown }

// Committed root selectors only, keyed by a per-hook token so the hook never mutates its own state.
const committed = new Map<object, Entry>()
// One check per interval: a selector that read a channel field stays wrong until its next root write.
const CHECK_INTERVAL_MS = 1000
let checkQueued = false

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
  checkQueued = false
  committed.forEach((entry) => {
    let value: unknown
    try {
      value = entry.read()
    } catch {
      return
    }
    if (!Object.is(value, entry.last)) {
      entry.last = value
      console.error(
        'A root app-store selector changed on a channel-only write; read channel fields through useAppStoreWithChannels.',
        entry.read
      )
    }
  })
}

/** After a channel-only write skipped root selectors: any whose result moved read a channel field. */
export function checkSkippedRootSelectors(): void {
  if (!checkQueued) {
    checkQueued = true
    setTimeout(checkCommittedRootSelectors, CHECK_INTERVAL_MS)
  }
}
