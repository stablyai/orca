// Keep disclosures outside windowed rows so scrolling cannot erase reader choices; standalone rows fall back to local state.

import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { VirtualItem } from '@tanstack/react-virtual'
import {
  KEPT_TRANSCRIPTS_PER_TAB,
  useNativeChatViewState
} from '../../pane/ownership/native-chat-view-memory'

export type NativeChatDisclosureStore = {
  read: (key: string) => boolean | undefined
  /** Opening with `group` (a key prefix) closes that group's other open keys: one open at a time. */
  write: (key: string, open: boolean, group?: string) => void
  toolRunMeasurements: Map<string, VirtualItem[]>
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
  const [toolRunMeasurements] = useState(() => new Map<string, VirtualItem[]>())
  const write = useCallback(
    (key: string, next: boolean, group?: string) => {
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
    [setOpen]
  )
  return useMemo(
    () => ({ read: (key: string) => open.get(key), write, toolRunMeasurements }),
    [open, write, toolRunMeasurements]
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
