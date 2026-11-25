import { persistedEntry, type OrcaAtom, type OrcaPersistedEntry } from './declarative-atoms'
import { assertPlainJson } from './declarative-evaluate'

const PERSIST_DEBOUNCE_MS = 400

/** Collects persisted atoms that changed and posts them in one batch, a moment later. */
export function createPersistQueue(options: {
  post: (entries: OrcaPersistedEntry[]) => void
  report: (error: unknown) => void
}): { add: (atom: OrcaAtom<unknown>) => void; flush: () => void } {
  const pending = new Set<OrcaAtom<unknown>>()
  let timer: ReturnType<typeof setTimeout> | null = null

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const entries: OrcaPersistedEntry[] = []
    for (const target of pending) {
      const entry = persistedEntry(target)
      if (!entry) {
        continue
      }
      try {
        assertPlainJson(entry.value, `persisted atom "${entry.key}"`)
        entries.push(entry)
      } catch (error) {
        options.report(error)
      }
    }
    pending.clear()
    if (entries.length > 0) {
      options.post(entries)
    }
  }

  return {
    add(target) {
      pending.add(target)
      timer ??= setTimeout(flush, PERSIST_DEBOUNCE_MS)
    },
    flush
  }
}
