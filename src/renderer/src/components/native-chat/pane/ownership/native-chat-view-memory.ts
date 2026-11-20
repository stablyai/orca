import { createContext, useCallback, useContext, useState, type SetStateAction } from 'react'
import { useAppStore } from '@/store'

/** The chat tab a released-able view belongs to; null on surfaces that never release their view. */
export type NativeChatViewTab = { tabId: string; worktreeId: string }
export const NativeChatViewTabContext = createContext<NativeChatViewTab | null>(null)

// Why: chat views are released while hidden to bound memory. Small view choices (expanded turns, goal entry,
// a half-answered question, the reading position) live here per tab and end exactly when the tab closes.
const records = new Map<string, Map<string, unknown>>()

export function isNativeChatViewTabOpen(tab: NativeChatViewTab): boolean {
  return (
    useAppStore
      .getState()
      .unifiedTabsByWorktree[tab.worktreeId]?.some((entry) => entry.id === tab.tabId) === true
  )
}

export function readNativeChatViewMemory<T>(tab: NativeChatViewTab, key: string): T | undefined {
  return records.get(tab.tabId)?.get(key) as T | undefined
}

/** Writes after the tab closed are dropped, so a late settlement can't recreate a closed tab's record. */
export function writeNativeChatViewMemory(
  tab: NativeChatViewTab,
  key: string,
  value: unknown
): void {
  if (value === undefined) {
    records.get(tab.tabId)?.delete(key)
    return
  }
  if (!isNativeChatViewTabOpen(tab)) {
    return
  }
  let record = records.get(tab.tabId)
  if (!record) {
    record = new Map()
    records.set(tab.tabId, record)
  }
  record.set(key, value)
}

export function releaseNativeChatViewMemory(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    records.delete(tabId)
  }
}

/**
 * `useState` whose value outlives a released view of the same tab. The setter is bound to the key it was
 * created with and writes through at once, so a request settling after the view is gone still lands.
 * `initial` must be stable (a constant), like a default.
 */
export function useNativeChatViewState<T>(
  key: string,
  initial: T
): [T, (action: SetStateAction<T>) => void] {
  const tab = useContext(NativeChatViewTabContext)
  const read = useCallback(
    (): T => (tab ? (readNativeChatViewMemory<T>(tab, key) ?? initial) : initial),
    [tab, key, initial]
  )
  const [state, setState] = useState(() => ({ key, value: read() }))
  const current = state.key === key ? state : { key, value: read() }
  if (current !== state) {
    setState(current)
  }
  const setValue = useCallback(
    (action: SetStateAction<T>) => {
      const apply = (value: T): T =>
        typeof action === 'function' ? (action as (previous: T) => T)(value) : action
      if (!tab) {
        setState((local) => (local.key === key ? { key, value: apply(local.value) } : local))
        return
      }
      const next = apply(read())
      writeNativeChatViewMemory(tab, key, next)
      setState((local) => (local.key === key ? { key, value: next } : local))
    },
    [tab, key, read]
  )
  return [current.value, setValue]
}

/** A tab-kept value read once when the view mounts; without a key or a tab, nothing is kept. */
export function useNativeChatViewMemory<T>(key: string | undefined): {
  saved: T | undefined
  write: (value: T | undefined) => void
} {
  const tab = useContext(NativeChatViewTabContext)
  const [saved] = useState(() =>
    tab && key !== undefined ? readNativeChatViewMemory<T>(tab, key) : undefined
  )
  const write = useCallback(
    (value: T | undefined) => {
      if (tab && key !== undefined) {
        writeNativeChatViewMemory(tab, key, value)
      }
    },
    [tab, key]
  )
  return { saved, write }
}
