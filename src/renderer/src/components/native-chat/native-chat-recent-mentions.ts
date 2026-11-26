import { useSyncExternalStore } from 'react'

// The last few members picked from `@` in any chat (ids, else names), newest first; they lead their
// match tier.
const STORAGE_KEY = 'orca.nativeChat.recentMentions'
const LIMIT = 5
const EMPTY: readonly string[] = []

let recent: readonly string[] | null = null
const listeners = new Set<() => void>()

function read(): readonly string[] {
  if (recent) {
    return recent
  }
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
    recent = Array.isArray(saved)
      ? saved.filter((name): name is string => typeof name === 'string').slice(0, LIMIT)
      : EMPTY
  } catch {
    recent = EMPTY
  }
  return recent
}

export function recordNativeChatRecentMention(name: string): void {
  const next = [name, ...read().filter((entry) => entry !== name)].slice(0, LIMIT)
  recent = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage full or blocked: the order still holds for this session.
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Another window's pick lands in storage; re-read it so this window's next pick doesn't drop it.
  const onStorage = (event: StorageEvent): void => {
    if (event.key === STORAGE_KEY) {
      recent = null
      listener()
    }
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function useNativeChatRecentMentions(): readonly string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY)
}
