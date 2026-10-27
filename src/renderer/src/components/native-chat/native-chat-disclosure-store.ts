// Keep disclosures outside windowed rows so scrolling cannot erase reader choices; standalone rows fall back to local state.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'

/** Where the reader left an opened run's own scroll box. */
export type NativeChatRunScroll = { top: number; followsEnd: boolean }

export type NativeChatDisclosureStore = {
  read: (key: string) => boolean | undefined
  write: (key: string, open: boolean) => void
  /** Forget on disclosure close; use a plain map so internal scrolling cannot rerender the transcript. */
  runScroll: Map<string, NativeChatRunScroll>
}

export const NativeChatDisclosureContext = createContext<NativeChatDisclosureStore | null>(null)

/** The transcript row whose markdown is rendering, so a code block inside it can key its wrap. */
export const NativeChatMarkdownRowKeyContext = createContext<string | undefined>(undefined)

/** Bound disclosure memory across long-lived sessions. */
export const MAX_NATIVE_CHAT_DISCLOSURES = 512

export function useNativeChatDisclosures(): NativeChatDisclosureStore {
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [runScroll] = useState(() => new Map<string, NativeChatRunScroll>())
  const write = useCallback(
    (key: string, next: boolean) => {
      if (!next) {
        runScroll.delete(key)
      }
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
