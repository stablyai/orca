import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { Dispatch, SetStateAction } from 'react'
type Cell<T> = { current: T; listeners: Set<() => void>; retired: boolean }
export const nativeChatViewRetirements = new Set<(key: string) => void>()
export const nativeChatViewIdentities = new Set<string>()
export const NativeChatViewIdentity = createContext<string | null>(null)
/** A typed field owns data only; mounted readers alone own its listeners. */
export function createNativeChatReturnField<T>() {
  const records = new Map<string, Map<string, Cell<T>>>()
  nativeChatViewRetirements.add((key) => {
    const base = key.split('\0')[0] ?? key
    const owned = records.get(base)
    if (!owned) {
      return
    }
    for (const [identity, cell] of owned) {
      if (identity === key || key === base || identity.startsWith(`${key}\0`)) {
        cell.retired = true
        owned.delete(identity)
      }
    }
    if (owned.size === 0) {
      records.delete(base)
    }
  })
  return (key: string | null, initial: () => T): Cell<T> => {
    if (key === null) {
      return { current: initial(), listeners: new Set(), retired: false }
    }
    const base = key.split('\0')[0] ?? key
    nativeChatViewIdentities.add(base)
    const owned = records.get(base) ?? new Map<string, Cell<T>>()
    records.set(base, owned)
    let cell = owned.get(key)
    if (!cell) {
      cell = { current: initial(), listeners: new Set(), retired: false }
      owned.set(key, cell)
    }
    return cell
  }
}

export function retireNativeChatViewState(key: string): void {
  nativeChatViewIdentities.delete(key)
  for (const retire of nativeChatViewRetirements) {
    retire(key)
  }
}

export function useNativeChatReturnRef<T>(
  field: ReturnType<typeof createNativeChatReturnField<T>>,
  initial: () => T,
  scope = ''
): Cell<T> {
  const key = useContext(NativeChatViewIdentity)
  const read = useMemo(() => {
    let cell: Cell<T> | undefined
    return (initial: () => T) => (cell ??= field(key === null ? null : `${key}\0${scope}`, initial))
  }, [field, key, scope])
  return read(initial)
}
function isUpdater<T>(next: SetStateAction<T>): next is (value: T) => T {
  return typeof next === 'function'
}

export function useNativeChatReturnState<T>(
  field: ReturnType<typeof createNativeChatReturnField<T>>,
  initial: () => T
): [T, Dispatch<SetStateAction<T>>] {
  const cell = useNativeChatReturnRef(field, initial)
  const subscribe = useCallback(
    (listener: () => void) => {
      cell.listeners.add(listener)
      return () => {
        cell.listeners.delete(listener)
      }
    },
    [cell]
  )
  const value = useSyncExternalStore(subscribe, () => cell.current)
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      if (cell.retired) {
        return
      }
      cell.current = isUpdater(next) ? next(cell.current) : next
      for (const listener of cell.listeners) {
        listener()
      }
    },
    [cell]
  )
  return [value, update]
}
