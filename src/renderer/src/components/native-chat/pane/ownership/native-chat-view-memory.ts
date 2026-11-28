import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type SetStateAction
} from 'react'
import { useAppStore } from '@/store'

/** The chat tab a releasable view belongs to; null on surfaces that never release their view. */
export type NativeChatViewTab = { tabId: string; worktreeId: string }
export const NativeChatViewTabContext = createContext<NativeChatViewTab | null>(null)

// Why: chat views are released while hidden to bound memory. Their small view state (expanded turns and
// details, goal entry, a half-made answer, the reading position) lives here per tab, like an editor's view-state
// memento, and ends exactly when the tab closes. Layers report which tabs are open, so writes check in O(1).
/** Per-transcript state keeps this many transcripts per tab: a rewind or /clear leaves the old one's behind. */
export const KEPT_TRANSCRIPTS_PER_TAB = 16
/** Per-prompt view choices (a folded question, an opened detail) are kept for this many prompts per tab. */
export const KEPT_PROMPT_VIEWS = 8

const records = new Map<string, Map<string, unknown>>()
const listeners = new Map<string, Set<() => void>>()

/** A closed tab's view state ends with it. */
export function releaseNativeChatViewTabs(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    records.delete(tabId)
    listeners.get(tabId)?.forEach((listener) => listener())
  }
}

/** Why the tab store, not a list layers keep: a view's first write can run before its layer's effects. */
export function isNativeChatViewTabLive(tab: NativeChatViewTab): boolean {
  return (
    useAppStore
      .getState()
      .unifiedTabsByWorktree[tab.worktreeId]?.some((entry) => entry.id === tab.tabId) === true
  )
}

export function readNativeChatViewMemory<T>(tab: NativeChatViewTab, key: string): T | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each key is written only by the hook that reads it with this T.
  return records.get(tab.tabId)?.get(key) as T | undefined
}

/** Writes after the tab closed are dropped, so a late settlement can't recreate a closed tab's record. */
/** With `keepNewest`, keys sharing this key's prefix (up to its first ':') beyond the newest few are dropped. */
export function writeNativeChatViewMemory(
  tab: NativeChatViewTab,
  key: string,
  value: unknown,
  keepNewest?: number
): void {
  const record = records.get(tab.tabId)
  if (value === undefined) {
    if (!record?.delete(key)) {
      return
    }
  } else if (record?.get(key) === value) {
    return
  } else if (record) {
    record.delete(key)
    record.set(key, value)
    if (keepNewest !== undefined) {
      dropOldestBeyond(record, key, keepNewest)
    }
  } else if (isNativeChatViewTabLive(tab)) {
    // Only a tab's first record checks the tab store; a record exists only until its tab's release.
    records.set(tab.tabId, new Map([[key, value]]))
  } else {
    return
  }
  listeners.get(tab.tabId)?.forEach((listener) => listener())
}

function dropOldestBeyond(record: Map<string, unknown>, key: string, keep: number): void {
  const prefix = key.slice(0, key.indexOf(':') + 1)
  const group = [...record.keys()].filter((entry) => entry.startsWith(prefix))
  for (const stale of group.slice(0, Math.max(0, group.length - keep))) {
    record.delete(stale)
  }
}

function subscribeToTab(tabId: string, listener: () => void): () => void {
  let set = listeners.get(tabId)
  if (!set) {
    set = new Set()
    listeners.set(tabId, set)
  }
  const own = set
  own.add(listener)
  return () => {
    own.delete(listener)
    if (own.size === 0 && listeners.get(tabId) === own) {
      listeners.delete(tabId)
    }
  }
}

function isUpdater<T>(action: SetStateAction<T>): action is (previous: T) => T {
  return typeof action === 'function'
}

const NO_SUBSCRIPTION = (): (() => void) => () => {}

/**
 * `useState` whose value lives with the tab, so a released view returns with it and a request settling after
 * the view is gone still updates the view that replaced it. `initial` must be stable, like a default.
 */
export function useNativeChatViewState<T>(
  /** Without a key the value stays local to the view. */
  key: string | undefined,
  initial: T,
  keepNewest?: number
): [T, (action: SetStateAction<T>) => void] {
  const viewTab = useContext(NativeChatViewTabContext)
  const tab = key === undefined ? null : viewTab
  const [local, setLocal] = useState(initial)
  const subscribe = useCallback(
    (listener: () => void) => (tab ? subscribeToTab(tab.tabId, listener) : NO_SUBSCRIPTION()),
    [tab]
  )
  const kept = useSyncExternalStore(subscribe, () =>
    tab && key !== undefined ? (readNativeChatViewMemory<T>(tab, key) ?? initial) : initial
  )
  const setValue = useCallback(
    (action: SetStateAction<T>) => {
      const apply = (value: T): T => (isUpdater(action) ? action(value) : action)
      if (!tab || key === undefined) {
        setLocal(apply)
        return
      }
      const next = apply(readNativeChatViewMemory<T>(tab, key) ?? initial)
      writeNativeChatViewMemory(tab, key, next === initial ? undefined : next, keepNewest)
    },
    [tab, key, initial, keepNewest]
  )
  return [tab ? kept : local, setValue]
}

/** `useNativeChatViewState` plus the value last rendered, for guards inside stable callbacks. */
export function useNativeChatViewStateRef<T>(
  key: string,
  initial: T
): [T, (action: SetStateAction<T>) => void, RefObject<T>] {
  const [value, setValue] = useNativeChatViewState(key, initial)
  const shown = useRef(value)
  useLayoutEffect(() => {
    shown.current = value
  })
  return [value, setValue, shown]
}

/** A mutable ref kept with the tab, so a guard a released view set still holds in the view that replaces it. */
export function useNativeChatViewRef<T>(key: string, initial: T): { current: T } {
  const tab = useContext(NativeChatViewTabContext)
  const [ref] = useState(() => {
    const kept = tab ? readNativeChatViewMemory<{ current: T }>(tab, key) : undefined
    return kept ?? { current: initial }
  })
  useLayoutEffect(() => {
    if (tab) {
      writeNativeChatViewMemory(tab, key, ref)
    }
  }, [tab, key, ref])
  return ref
}

/** A tab-kept value read when the view mounts and when its key changes; without a key or a tab, nothing is kept. */
export function useNativeChatViewMemory<T>(
  key: string | undefined,
  keepNewest?: number
): {
  saved: T | undefined
  write: (value: T | undefined) => void
} {
  const tab = useContext(NativeChatViewTabContext)
  const read = (): T | undefined =>
    tab && key !== undefined ? readNativeChatViewMemory<T>(tab, key) : undefined
  // Read again when the key changes: a remounted chat learns its conversation's key only once history loads.
  const [held, setHeld] = useState(() => ({ key, saved: read() }))
  let saved = held.saved
  if (held.key !== key) {
    saved = read()
    setHeld({ key, saved })
  }
  const write = useCallback(
    (value: T | undefined) => {
      if (tab && key !== undefined) {
        writeNativeChatViewMemory(tab, key, value, keepNewest)
      }
    },
    [tab, key, keepNewest]
  )
  return { saved, write }
}
