import { useSyncExternalStore } from 'react'

// Each listed bot row's purpose line (its SOUL.md description), as the row last showed it.
// The row's own reader keeps it current; the Bots search reads it so it never reads SOUL.md itself.
const purposes = new Map<string, string>()
let reader = getBotPurpose
const listeners = new Set<() => void>()

function publish(): void {
  reader = (key) => getBotPurpose(key)
  for (const listener of listeners) {
    listener()
  }
}

/** Sets or clears a row's purpose, keyed by `botSidebarEntryKey`. */
export function setBotPurpose(key: string, purpose: string | null): void {
  if ((purposes.get(key) ?? null) === purpose) {
    return
  }
  if (purpose === null) {
    purposes.delete(key)
  } else {
    purposes.set(key, purpose)
  }
  publish()
}

const holders = new Map<string, number>()

/** A row listing `key` holds its purpose; it clears once the last such row unmounts, since a bot
 *  can list under two groups at once. Returns the release. */
export function holdBotPurpose(key: string): () => void {
  holders.set(key, (holders.get(key) ?? 0) + 1)
  return () => {
    const left = (holders.get(key) ?? 1) - 1
    if (left > 0) {
      holders.set(key, left)
      return
    }
    holders.delete(key)
    setBotPurpose(key, null)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function read(): typeof getBotPurpose {
  return reader
}

export function getBotPurpose(key: string): string | null {
  return purposes.get(key) ?? null
}

/** A consistent render revision without copying the rows' text on each arrival or removal. */
export function useBotPurposeReader(): typeof getBotPurpose {
  return useSyncExternalStore(subscribe, read)
}
