// A small map kept in localStorage, which every window of this origin shares. Each entry is its own
// item (`<storage key>:<entry key>`), and a write touches only the entries it changes, so two windows
// changing different notes at the same moment never overwrite each other. For the same entry the
// last write wins, except that a change storage refused here keeps winning in this window until it
// lands (it is replayed over every read and retried on every write).

export type NativeChatNotesStorage<T> = {
  get: (key: string) => T | undefined
  /** In the order entries were last written, oldest first. */
  keys: () => string[]
  /** Applies `change` on top of the stored map; `change` returns false when it changed nothing.
   *  Returns whether storage now holds every change from this window (false: some are kept in this
   *  window only, for now). */
  update: (change: (entries: Map<string, T>) => boolean) => boolean
  /** Retries the changes storage refused; returns whether storage now holds them all. */
  save: () => boolean
  subscribe: (listener: () => void) => () => void
  /** Test-only: forget the in-memory copy and read storage again. */
  resetForTests: () => void
}

type StoredEntry = { t: number; v: unknown }

function isStoredEntry(value: unknown): value is StoredEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    't' in value &&
    typeof value.t === 'number' &&
    'v' in value
  )
}

export function createNativeChatNotesStorage<T>(
  storageKey: string,
  parse: (value: unknown) => T | null
): NativeChatNotesStorage<T> {
  const prefix = `${storageKey}:`
  const itemKey = (key: string): string => `${prefix}${encodeURIComponent(key)}`
  let entries = new Map<string, T>()
  let loaded = false
  let listening = false
  let rereadQueued = false
  let clock = 0
  // This window's changes storage refused, per key (undefined: removed). Every read replays them and
  // every write retries them, so they are never lost to another window's write.
  const unsaved = new Map<string, T | undefined>()
  const listeners = new Set<() => void>()

  // Later than every stamp this window gave, so a rewritten entry moves to the end.
  const stamp = (): number => {
    clock = Math.max(clock + 1, Date.now())
    return clock
  }
  const write = (key: string, value: T | undefined): boolean => {
    try {
      if (value === undefined) {
        globalThis.localStorage?.removeItem(itemKey(key))
      } else {
        globalThis.localStorage?.setItem(itemKey(key), JSON.stringify({ t: stamp(), v: value }))
      }
      unsaved.delete(key)
      return true
    } catch {
      unsaved.set(key, value)
      return false
    }
  }
  const read = (): Map<string, T> => {
    const found: { key: string; t: number; value: T }[] = []
    const storage = globalThis.localStorage
    try {
      if (storage) {
        for (let index = 0; index < storage.length; index += 1) {
          const item = storage.key(index)
          if (!item?.startsWith(prefix)) {
            continue
          }
          const stored: unknown = JSON.parse(storage.getItem(item) ?? 'null')
          const value = isStoredEntry(stored) ? parse(stored.v) : null
          if (value !== null && isStoredEntry(stored)) {
            found.push({ key: decodeURIComponent(item.slice(prefix.length)), t: stored.t, value })
            clock = Math.max(clock, stored.t)
          }
        }
      }
    } catch {
      // Unreadable storage only costs notes from an earlier session or another window.
    }
    found.sort((a, b) => a.t - b.t || (a.key < b.key ? -1 : 1))
    const next = new Map<string, T>()
    for (const { key, value } of found) {
      next.set(key, value)
    }
    for (const [key, value] of unsaved) {
      next.delete(key)
      if (value !== undefined) {
        next.set(key, value)
      }
    }
    return next
  }
  const notify = (): void => {
    for (const listener of listeners) {
      listener()
    }
  }
  const current = (): Map<string, T> => {
    if (!loaded) {
      loaded = true
      entries = read()
    }
    if (!listening && typeof globalThis.addEventListener === 'function') {
      listening = true
      globalThis.addEventListener('storage', (event: StorageEvent) => {
        if (event.key !== null && !event.key.startsWith(prefix)) {
          return
        }
        // One write per entry arrives as one event each: read them all once.
        if (!rereadQueued) {
          rereadQueued = true
          queueMicrotask(() => {
            rereadQueued = false
            entries = read()
            notify()
          })
        }
      })
    }
    return entries
  }
  const save = (): boolean => {
    // Deleting the entry being visited is safe in a Map walk.
    for (const [key, value] of unsaved) {
      write(key, value)
    }
    return unsaved.size === 0
  }

  return {
    get: (key) => current().get(key),
    keys: () => [...current().keys()],
    update: (change) => {
      current()
      const base = read()
      const before = new Map(base)
      if (!change(base)) {
        return unsaved.size === 0
      }
      entries = base
      const changed = new Set<string>()
      for (const key of new Set([...before.keys(), ...base.keys()])) {
        if (before.get(key) !== base.get(key)) {
          changed.add(key)
        }
      }
      // Earlier refused changes first, then this one's, in its order.
      save()
      for (const key of base.keys()) {
        if (changed.delete(key)) {
          write(key, base.get(key))
        }
      }
      for (const key of changed) {
        write(key, undefined)
      }
      notify()
      return unsaved.size === 0
    },
    save,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    resetForTests: () => {
      entries = new Map()
      loaded = false
      unsaved.clear()
      listeners.clear()
    }
  }
}

/** Moves (or, with `keepSource`, copies) every entry keyed `${from}\0…` to `${to}\0…`, as a draft
 *  moves to another scope. Where the destination already has that entry, `combine` decides what it
 *  keeps; without one the destination's own entry stays. */
export function moveNativeChatNotesEntries<T>(
  entries: Map<string, T>,
  from: string,
  to: string,
  rescope: (value: T) => T = (value) => value,
  keepSource = false,
  combine: (existing: T, moved: T) => T = (existing) => existing
): boolean {
  if (from === to) {
    return false
  }
  let moved = false
  // A snapshot: the moved entries are added to the map being walked.
  for (const [key, value] of Array.from(entries)) {
    if (key.startsWith(`${from}\0`)) {
      if (!keepSource) {
        entries.delete(key)
      }
      const destination = `${to}\0${key.slice(from.length + 1)}`
      const existing = entries.get(destination)
      entries.set(
        destination,
        existing === undefined ? rescope(value) : combine(existing, rescope(value))
      )
      moved = true
    }
  }
  return moved
}
