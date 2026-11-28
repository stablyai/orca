// Whose tabs this window shows in a shared agent's Home: its own (no entry) or another person's list,
// and which of their tabs it shows. Window-local and never saved: viewing writes nothing anywhere.
import { useSyncExternalStore } from 'react'
import type { z } from 'zod'
import type { SessionTabListPerson } from '../../../../../shared/rpc-contract/session-tabs/session-tab-list-person-params'

export type TabListPerson = z.infer<typeof SessionTabListPerson>

export type ViewedTabList = {
  person: TabListPerson
  /** The tab this window shows from their list; null, the one their list has active. */
  pickedTabId: string | null
}

const views = new Map<string, ViewedTabList>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function sameTabListPerson(a: TabListPerson, b: TabListPerson): boolean {
  return a === 'owner' || b === 'owner' ? a === b : a.accountId === b.accountId
}

/** Shows `person`'s tabs in the Home, or with null this window's own again. */
export function viewTabList(homeKey: string, person: TabListPerson | null): void {
  const current = views.get(homeKey)
  if (person === null) {
    if (current && views.delete(homeKey)) {
      changed()
    }
    return
  }
  if (current && sameTabListPerson(current.person, person)) {
    return
  }
  views.set(homeKey, { person, pickedTabId: null })
  changed()
}

/** Shows one of their tabs here; their own pick stays theirs. */
export function pickViewedTab(homeKey: string, tabId: string): void {
  const current = views.get(homeKey)
  if (current && current.pickedTabId !== tabId) {
    views.set(homeKey, { ...current, pickedTabId: tabId })
    changed()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useViewedTabList(homeKey: string | null): ViewedTabList | null {
  return useSyncExternalStore(subscribe, () => (homeKey ? (views.get(homeKey) ?? null) : null))
}
