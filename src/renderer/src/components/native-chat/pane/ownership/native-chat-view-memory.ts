import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore,
  type SetStateAction
} from 'react'
import { useAppStore } from '@/store'

/** The chat tab a releasable view belongs to; null on surfaces that never release their view. */
export type NativeChatViewTab = {
  tabId: string
  worktreeId: string
  /** The host and session the tab shows now; guards belong to it, so a tab switched to another chat starts clear. */
  conversation?: string
}
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
const onRelease = new Map<string, Set<() => void>>()

/** A closed tab's view state ends with it, after work a released view left open is wound up. */
export function releaseNativeChatViewTabs(tabIds: Iterable<string>): void {
  for (const tabId of tabIds) {
    const pending = onRelease.get(tabId)
    onRelease.delete(tabId)
    pending?.forEach((release) => release())
    records.delete(tabId)
    listeners.get(tabId)?.forEach((listener) => listener())
  }
}

/**
 * Open in any workspace: a tab a rename or drag moved still counts. Its own workspace answers on a switch; only a
 * tab that left it (moved or closed, both rare) walks the others.
 */
export function isNativeChatViewTabOpenAnywhere(tab: NativeChatViewTab): boolean {
  const byWorktree = useAppStore.getState().unifiedTabsByWorktree
  if (byWorktree[tab.worktreeId]?.some((entry) => entry.id === tab.tabId)) {
    return true
  }
  return Object.values(byWorktree).some((tabs) => tabs.some((entry) => entry.id === tab.tabId))
}

let pageHideInstalled = false
/** A reload or quit winds up what released views left open, as their own `pagehide` handlers would have. */
function windUpOnPageHide(): void {
  if (pageHideInstalled || typeof window === 'undefined') {
    return
  }
  pageHideInstalled = true
  window.addEventListener('pagehide', () => {
    const pending = [...onRelease.values()].flatMap((set) => [...set])
    onRelease.clear()
    pending.forEach((release) => release())
  })
}

/**
 * Runs `release` when the tab closes or the page goes away, unless the returned cancel runs first (a remounted
 * view took it back). Registered when a view unmounts, which is rare, so the open-tab check can walk the tabs.
 */
export function onNativeChatViewTabRelease(
  tab: NativeChatViewTab,
  release: () => void
): () => void {
  if (!isNativeChatViewTabOpenAnywhere(tab)) {
    release()
    return () => {}
  }
  windUpOnPageHide()
  let set = onRelease.get(tab.tabId)
  if (!set) {
    set = new Set()
    onRelease.set(tab.tabId, set)
  }
  const own = set
  own.add(release)
  return () => {
    own.delete(release)
    if (own.size === 0 && onRelease.get(tab.tabId) === own) {
      onRelease.delete(tab.tabId)
    }
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

/** A tab's record for this lifetime of the tab, made if the tab is open; null once it closed. */
function lifeOf(tab: NativeChatViewTab): Map<string, unknown> | null {
  let record = records.get(tab.tabId)
  if (!record && isNativeChatViewTabLive(tab)) {
    record = new Map()
    records.set(tab.tabId, record)
  }
  return record ?? null
}

/**
 * Writes after the tab closed are dropped, so a late settlement can't recreate a closed tab's record; with `life`,
 * so are writes from a view of an earlier lifetime of a tab id that closed and opened again.
 * With `keepNewest`, keys sharing this key's prefix (up to its first ':') beyond the newest few are dropped,
 * except values still in flight (`inFlight: true`).
 */
export function writeNativeChatViewMemory(
  tab: NativeChatViewTab,
  key: string,
  value: unknown,
  keepNewest?: number,
  life?: Map<string, unknown> | null
): void {
  const record = records.get(tab.tabId)
  if (life !== undefined && (life === null || record !== life)) {
    return
  }
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
  const group = [...record]
    .filter(([entry, value]) => entry.startsWith(prefix) && !isInFlight(value))
    .map(([entry]) => entry)
  for (const stale of group.slice(0, Math.max(0, group.length - keep))) {
    record.delete(stale)
  }
}

function isInFlight(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'inFlight' in value && value.inFlight === true
  )
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
  // This lifetime of the tab: a request settling after the tab closed and its id opened again writes nothing.
  const life = useMemo(() => (tab ? lifeOf(tab) : null), [tab])
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
      writeNativeChatViewMemory(tab, key, next === initial ? undefined : next, keepNewest, life)
    },
    [tab, key, initial, keepNewest, life]
  )
  return [tab ? kept : local, setValue]
}

/**
 * An in-flight guard (busy, pending, a preview) kept with the tab: a view released mid-request returns still
 * guarded, and a request settling after release clears it. `read` is synchronous, for same-frame double clicks.
 * Back at `initial`, the entry is deleted; per-item keys whose settled value stays pass `keepNewest`.
 */
export function useNativeChatViewGuard<T>(
  /** Without a key the guard stays local to the view. */
  key: string | undefined,
  initial: T,
  keepNewest?: number
): [T, (action: SetStateAction<T>) => void, () => T] {
  const viewTab = useContext(NativeChatViewTabContext)
  const tab = key === undefined ? null : viewTab
  // Suffixed, so `keepNewest` still groups by the key's own prefix.
  const keptKey =
    key === undefined || tab?.conversation === undefined ? key : `${key}@${tab.conversation}`
  const [value, setValue] = useNativeChatViewState(keptKey, initial, keepNewest)
  const local = useRef(initial)
  const read = useCallback(
    (): T =>
      tab && keptKey !== undefined
        ? (readNativeChatViewMemory<T>(tab, keptKey) ?? initial)
        : local.current,
    [tab, keptKey, initial]
  )
  const set = useCallback(
    (action: SetStateAction<T>) => {
      const next = isUpdater(action) ? action(read()) : action
      local.current = next
      setValue(next)
    },
    [read, setValue]
  )
  return [value, set, read]
}

/** A `{ current }` view of a guard; made outside render code, which can't compile accessors. */
function guardAsRef<T>(read: () => T, set: (value: T) => void): { current: T } {
  return {
    get current(): T {
      return read()
    },
    set current(value: T) {
      set(value)
    }
  }
}

/** `useNativeChatViewGuard` as a mutable ref, for code that sets `.current`; back at `initial`, nothing is kept. */
export function useNativeChatViewGuardRef<T>(key: string, initial: T): { current: T } {
  const [, set, read] = useNativeChatViewGuard(key, initial)
  return useMemo(() => guardAsRef(read, set), [read, set])
}

/** A mutable ref kept with the tab, so a guard a released view set still holds in the view that replaces it. */
export function useNativeChatViewRef<T>(
  /** Without a key the ref stays local to the view. */
  key: string | undefined,
  initial: T
): { current: T } {
  const viewTab = useContext(NativeChatViewTabContext)
  const tab = key === undefined ? null : viewTab
  const [ref] = useState(() => {
    const kept =
      tab && key !== undefined ? readNativeChatViewMemory<{ current: T }>(tab, key) : undefined
    return kept ?? { current: initial }
  })
  useLayoutEffect(() => {
    if (tab && key !== undefined) {
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
