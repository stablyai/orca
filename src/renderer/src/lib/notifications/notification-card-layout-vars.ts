import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { NOTIFICATION_CARD_STACK_HEIGHT_VAR } from './notification-card-stack-height'

// Why not :root: an inherited var change there restyles the whole document; only the cards and toaster read these.
const readers = new Set<HTMLElement>()
const values = new Map<string, string>()
const listeners = new Set<() => void>()

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether notification cards are showing, for code that checks outside render. */
export function isNotificationCardStackOccupied(): boolean {
  return values.has(NOTIFICATION_CARD_STACK_HEIGHT_VAR)
}

export function useNotificationCardStackOccupied(): boolean {
  return useSyncExternalStore(subscribe, isNotificationCardStackOccupied, () => false)
}

function writeVar(reader: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    reader.style.removeProperty(name)
  } else {
    reader.style.setProperty(name, value)
  }
}

/** Sets a notification card layout var on every reader, or clears it with null; unchanged values skip the write. */
export function setNotificationCardLayoutVar(name: string, value: string | null): void {
  if ((values.get(name) ?? null) === value) {
    return
  }
  if (value === null) {
    values.delete(name)
  } else {
    values.set(name, value)
  }
  for (const reader of readers) {
    writeVar(reader, name, value)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function registerNotificationCardLayoutVarReader(reader: HTMLElement): () => void {
  readers.add(reader)
  for (const [name, value] of values) {
    writeVar(reader, name, value)
  }
  return () => {
    readers.delete(reader)
    for (const name of values.keys()) {
      writeVar(reader, name, null)
    }
  }
}

/** Gives this element (and its subtree) the cards' layout vars. */
export function useNotificationCardLayoutVarReader(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const reader = ref.current
    if (!reader) {
      return
    }
    return registerNotificationCardLayoutVarReader(reader)
  }, [ref])
}
