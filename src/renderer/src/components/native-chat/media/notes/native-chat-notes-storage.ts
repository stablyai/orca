// A small map kept in localStorage, which every window of this origin shares. Each write starts from
// what storage holds now, so one window never drops notes another window saved or removed.

export type NativeChatNotesStorage<T> = {
  get: (key: string) => T | undefined
  /** In insertion order, oldest first. */
  keys: () => string[]
  /** Applies `change` on top of the stored map; `change` returns false when it changed nothing.
   *  Resolves whether storage now holds the change (false: kept in this window only, for now). */
  update: (change: (entries: Map<string, T>) => boolean) => boolean
  subscribe: (listener: () => void) => () => void
  /** Test-only: forget the in-memory copy and read storage again. */
  resetForTests: () => void
}

export function createNativeChatNotesStorage<T>(
  storageKey: string,
  parse: (value: unknown) => T | null
): NativeChatNotesStorage<T> {
  let entries = new Map<string, T>()
  let loaded = false
  let listening = false
  // This window's changes storage refused, per key (undefined: removed). Every later read and write
  // starts from storage and replays only these, so another window's saves and removals survive.
  const unsaved = new Map<string, T | undefined>()
  const listeners = new Set<() => void>()

  const read = (): Map<string, T> => {
    const next = new Map<string, T>()
    try {
      const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '[]')
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        if (Array.isArray(entry) && typeof entry[0] === 'string') {
          const value = parse(entry[1])
          if (value !== null) {
            next.set(entry[0], value)
          }
        }
      }
    } catch {
      // Unreadable storage only costs notes from an earlier session or another window.
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
        if (event.key === storageKey) {
          entries = read()
          notify()
        }
      })
    }
    return entries
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
      try {
        globalThis.localStorage?.setItem(storageKey, JSON.stringify([...base]))
        unsaved.clear()
      } catch {
        // Quota or blocked storage: this window keeps the changed keys and replays them on later
        // writes until one lands.
        for (const key of new Set([...before.keys(), ...base.keys()])) {
          if (before.get(key) !== base.get(key)) {
            unsaved.set(key, base.get(key))
          }
        }
      }
      notify()
      return unsaved.size === 0
    },
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
 *  moves to another scope. */
export function moveNativeChatNotesEntries<T>(
  entries: Map<string, T>,
  from: string,
  to: string,
  rescope: (value: T) => T = (value) => value,
  keepSource = false
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
      entries.set(`${to}\0${key.slice(from.length + 1)}`, rescope(value))
      moved = true
    }
  }
  return moved
}
