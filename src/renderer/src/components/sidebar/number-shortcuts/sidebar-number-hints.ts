import { useSyncExternalStore } from 'react'
import {
  getSidebarNumberShortcutTargets,
  sidebarNumberHintKey
} from './sidebar-number-shortcut-targets'

const DIGIT_ADDRESSABLE_ROWS = 9
const NO_HINTS: ReadonlyMap<string, number> = new Map()

let hintIndexByKey: ReadonlyMap<string, number> = NO_HINTS
const listeners = new Set<() => void>()

function publish(next: ReadonlyMap<string, number>): void {
  if (next === hintIndexByKey) {
    return
  }
  hintIndexByKey = next
  for (const listener of listeners) {
    listener()
  }
}

/** Numbers the first nine shortcut rows from the same list Cmd/Ctrl+1–9 jumps through. */
export function showSidebarNumberHints(): void {
  const next = new Map<string, number>()
  getSidebarNumberShortcutTargets()
    .slice(0, DIGIT_ADDRESSABLE_ROWS)
    .forEach((target, index) => {
      const key = sidebarNumberHintKey(target)
      if (key !== null) {
        next.set(key, index)
      }
    })
  publish(next)
}

export function hideSidebarNumberHints(): void {
  publish(NO_HINTS)
}

export function sidebarNumberHintsShown(): boolean {
  return hintIndexByKey !== NO_HINTS
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The 0-based shortcut index shown on this row, or null while hints are hidden or the row has none. */
export function useSidebarNumberHint(hintKey: string): number | null {
  return useSyncExternalStore(subscribe, () => hintIndexByKey.get(hintKey) ?? null)
}
