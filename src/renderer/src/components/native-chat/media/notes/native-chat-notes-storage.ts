// A small map kept in localStorage, which every window of this origin shares. Each write starts from
// what storage holds now, so one window never drops notes another window saved or removed.

export type NativeChatNotesStorage<T> = {
  get: (key: string) => T | undefined
  /** In insertion order, oldest first. */
  keys: () => string[]
  /** Applies `change` on top of the stored map; `change` returns false when it changed nothing. */
  update: (change: (entries: Map<string, T>) => boolean) => void
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
  // A write storage refused (quota, blocked): memory is newer than storage until a write lands.
  let unsaved = false
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
        if (event.key === storageKey && !unsaved) {
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
      const inMemory = current()
      const base = unsaved ? new Map(inMemory) : read()
      if (!change(base)) {
        return
      }
      entries = base
      try {
        globalThis.localStorage?.setItem(storageKey, JSON.stringify([...base]))
        unsaved = false
      } catch {
        // Quota or blocked storage: the notes still work in this window for this session.
        unsaved = true
      }
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    resetForTests: () => {
      entries = new Map()
      loaded = false
      unsaved = false
      listeners.clear()
    }
  }
}

/** Moves every entry keyed `${from}\0…` to `${to}\0…`, as a draft moves to another scope. */
export function moveNativeChatNotesEntries<T>(
  entries: Map<string, T>,
  from: string,
  to: string,
  rescope: (value: T) => T = (value) => value
): boolean {
  if (from === to) {
    return false
  }
  let moved = false
  // A snapshot: the moved entries are added to the map being walked.
  for (const [key, value] of Array.from(entries)) {
    if (key.startsWith(`${from}\0`)) {
      entries.delete(key)
      entries.set(`${to}\0${key.slice(from.length + 1)}`, rescope(value))
      moved = true
    }
  }
  return moved
}
