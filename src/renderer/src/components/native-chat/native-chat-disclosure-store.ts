// Where a transcript row's open/closed disclosures live when the row itself may
// be unmounted.
//
// A tool run the reader opened is state they created. Held in the run's own
// `useState` it survives exactly as long as the row is mounted, which under
// windowing is "until you scroll past it" — the run silently re-collapses behind
// the reader's back. Rows read through this store when the transcript provides
// one, and fall back to their own state when they are rendered standalone.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'

export type NativeChatDisclosureStore = {
  read: (key: string) => boolean | undefined
  write: (key: string, open: boolean) => void
}

export const NativeChatDisclosureContext = createContext<NativeChatDisclosureStore | null>(null)

/** Bounded like the transcript's other per-turn map: a session that ran for a day
 *  should not carry every disclosure it ever opened. Eviction only reaches rows
 *  that are unmounted — a mounted row still has its own state to fall back on. */
export const MAX_NATIVE_CHAT_DISCLOSURES = 512

export function useNativeChatDisclosures(): NativeChatDisclosureStore {
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const write = useCallback((key: string, next: boolean) => {
    setOpen((current) => {
      if (current.get(key) === next) {
        return current
      }
      const updated = new Map(current)
      updated.set(key, next)
      if (updated.size > MAX_NATIVE_CHAT_DISCLOSURES) {
        const oldest = updated.keys().next().value
        if (oldest !== undefined && oldest !== key) {
          updated.delete(oldest)
        }
      }
      return updated
    })
  }, [])
  return useMemo(() => ({ read: (key: string) => open.get(key), write }), [open, write])
}

export type NativeChatDisclosure = {
  open: boolean
  /** A reader's choice: remembered past this row's lifetime. Stable for the
   *  component's whole life, so an effect can depend on it without re-firing. */
  setOpen: (next: boolean) => void
  /** A control the row derives its state from changed. Local only — the store is
   *  owned by an ancestor, and writing to it mid-render would update a component
   *  while another one renders. Callers encode the control in `key` instead, so a
   *  new control epoch reads as "no stored choice" and this value stands. */
  resetOpen: (next: boolean) => void
}

export function useNativeChatDisclosure(
  key: string | undefined,
  initialOpen: boolean
): NativeChatDisclosure {
  const store = useContext(NativeChatDisclosureContext)
  const [local, setLocal] = useState(initialOpen)
  const stored = key !== undefined && store !== null ? store.read(key) : undefined
  const target = useRef({ key, store })
  target.current = { key, store }
  const setOpen = useCallback((next: boolean) => {
    setLocal(next)
    const { key: currentKey, store: currentStore } = target.current
    if (currentKey !== undefined && currentStore !== null) {
      currentStore.write(currentKey, next)
    }
  }, [])
  return { open: stored ?? local, setOpen, resetOpen: setLocal }
}
