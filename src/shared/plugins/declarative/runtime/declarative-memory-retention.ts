import { memoryEntry, watchMemoryAtoms, type OrcaAtom } from './declarative-atoms'
import { assertPlainJson } from './declarative-evaluate'

// Why short: the guest is gone right after the save that replaces it, before a longer wait ends.
const RETAIN_DEBOUNCE_MS = 50
// The host's `ui.retain` schema takes at most this many entries per message.
const RETAIN_BATCH = 64

export type OrcaRetainedEntry = { key: string; version: number; value?: unknown }

/**
 * Dev hot reload: once the host asks (`ui.hydrate` with `retain`), posts keyed memory atoms that
 * change, so the next guest of this panel starts from them. A value that is not plain JSON is
 * posted without `value`, which makes the next guest start that atom over.
 */
export function createMemoryRetention(post: (entries: OrcaRetainedEntry[]) => void): {
  start: () => void
  flush: () => void
  stop: () => void
} {
  const pending = new Set<OrcaAtom<unknown>>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const entries: OrcaRetainedEntry[] = []
    for (const target of pending) {
      const entry = memoryEntry(target)
      if (!entry) {
        continue
      }
      try {
        assertPlainJson(entry.value, `atom "${entry.key}"`)
        entries.push(entry)
      } catch {
        // Memory atoms may hold anything; only JSON crosses a reload, silently.
        entries.push({ key: entry.key, version: entry.version })
      }
    }
    pending.clear()
    for (let start = 0; start < entries.length; start += RETAIN_BATCH) {
      post(entries.slice(start, start + RETAIN_BATCH))
    }
  }

  function add(target: OrcaAtom<unknown>): void {
    pending.add(target)
    timer ??= setTimeout(flush, RETAIN_DEBOUNCE_MS)
  }

  return {
    start() {
      if (!started) {
        started = true
        watchMemoryAtoms(add)
      }
    },
    flush,
    stop() {
      if (started) {
        flush()
        watchMemoryAtoms(null)
        started = false
      }
    }
  }
}
