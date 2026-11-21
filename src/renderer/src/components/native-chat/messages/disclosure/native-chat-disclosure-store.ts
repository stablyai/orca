// Keep disclosures outside windowed rows so scrolling cannot erase reader choices; standalone rows fall back to local state.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  KEPT_TRANSCRIPTS_PER_TAB,
  useNativeChatViewMemory,
  useNativeChatViewState
} from '../../pane/ownership/native-chat-view-memory'

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
  /** Opening with `group` (a key prefix) closes that group's other open keys: one open at a time. */
  write: (key: string, open: boolean, group?: string) => void
  /** Reset on disclosure writes; use a plain map so internal scrolling cannot rerender the transcript. */
  runScroll: Map<string, NativeChatRunScroll>
}

export const NativeChatDisclosureContext = createContext<NativeChatDisclosureStore | null>(null)

/** Bound disclosure memory across long-lived sessions. */
export const MAX_NATIVE_CHAT_DISCLOSURES = 512

const NO_DISCLOSURES: ReadonlyMap<string, boolean> = new Map()

/** `memoryKey` names the transcript within its chat tab, so a released chat view returns with its disclosures. */
export function useNativeChatDisclosures(memoryKey?: string): NativeChatDisclosureStore {
  const [open, setOpen] = useNativeChatViewState<ReadonlyMap<string, boolean>>(
    `disclosures:${memoryKey ?? ''}`,
    NO_DISCLOSURES,
    KEPT_TRANSCRIPTS_PER_TAB
  )
  const keptRunScroll = useNativeChatViewMemory<Map<string, NativeChatRunScroll>>(
    memoryKey === undefined ? undefined : `run-scroll:${memoryKey}`,
    KEPT_TRANSCRIPTS_PER_TAB
  )
  const [runScroll] = useState(() => keptRunScroll.saved ?? new Map<string, NativeChatRunScroll>())
  const { write: keepRunScroll } = keptRunScroll
  useEffect(() => keepRunScroll(runScroll), [keepRunScroll, runScroll])
  const write = useCallback(
    (key: string, next: boolean, group?: string) => {
      runScroll.delete(key)
      setOpen((current) => {
        const others =
          next && group !== undefined
            ? [...current].filter(
                ([other, open]) => open && other !== key && other.startsWith(group)
              )
            : []
        if (current.get(key) === next && others.length === 0) {
          return current
        }
        const updated = new Map(current)
        for (const [other] of others) {
          updated.set(other, false)
        }
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
    [runScroll, setOpen]
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
  initialOpen: boolean,
  /** A key prefix whose disclosures open one at a time. */
  group?: string
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
        write(key, next, group)
      }
    },
    [group, initialOpen, key, write]
  )
  return { open, setOpen }
}
