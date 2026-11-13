// Keep disclosures outside windowed rows so scrolling cannot erase reader choices; standalone rows fall back to local state.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

/** A reader's place in an opened run's box: a row, and how far into that row its top edge sits. */
export type NativeChatRunPosition = { key: string; offset: number }

/** Where the reader left an opened run's own scroll box: a row and offset, or the end. */
export type NativeChatRunScroll = {
  position: NativeChatRunPosition | null
  followsEnd: boolean
  /** Measured heights of details opened in rows the window no longer draws, so the box keeps their room. */
  detailHeights: ReadonlyMap<string, number>
}

export type NativeChatDisclosureStore = {
  read: (key: string) => boolean | undefined
  write: (key: string, open: boolean) => void
  /** Reset on disclosure writes; use a plain map so internal scrolling cannot rerender the transcript. */
  runScroll: Map<string, NativeChatRunScroll>
}

export const NativeChatDisclosureContext = createContext<NativeChatDisclosureStore | null>(null)

/** Bound disclosure memory across long-lived sessions. */
export const MAX_NATIVE_CHAT_DISCLOSURES = 512

export function useNativeChatDisclosures(): NativeChatDisclosureStore {
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [runScroll] = useState(() => new Map<string, NativeChatRunScroll>())
  const write = useCallback(
    (key: string, next: boolean) => {
      runScroll.delete(key)
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
    },
    [runScroll]
  )
  return useMemo(
    () => ({ read: (key: string) => open.get(key), write, runScroll }),
    [open, write, runScroll]
  )
}

export type NativeChatDisclosure = {
  open: boolean
  /** A reader's choice: remembered past this row's lifetime when keyed. */
  setOpen: (next: boolean) => void
}

export function useNativeChatDisclosure(
  key: string | undefined,
  initialOpen: boolean
): NativeChatDisclosure {
  const store = useContext(NativeChatDisclosureContext)
  const [local, setLocal] = useState({ key, initialOpen, open: initialOpen })
  const write = store?.write
  const isStored = key !== undefined && store !== null
  const localOpen =
    local.key === key && local.initialOpen === initialOpen ? local.open : initialOpen
  const open = isStored ? (store.read(key) ?? localOpen) : localOpen
  const setOpen = useCallback(
    (next: boolean) => {
      setLocal({ key, initialOpen, open: next })
      if (key !== undefined && write) {
        write(key, next)
      }
    },
    [initialOpen, key, write]
  )
  return { open, setOpen }
}
