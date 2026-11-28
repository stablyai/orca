// Whose tabs this window shows in a shared agent's Home: its own (no entry) or another person's list,
// and which of their tabs it shows. Window-local and never saved: viewing writes nothing anywhere.
import { useSyncExternalStore } from 'react'
import type { z } from 'zod'
import type { SessionTabListPerson } from '../../../../../shared/rpc-contract/session-tabs/session-tab-list-person-params'

export type TabListPerson = z.infer<typeof SessionTabListPerson>

/** A tab picked here from their list: by its id (their strip), or a chat by its session (Chats). */
export type ViewedTabPick = { tabId: string } | { sessionId: string }

export type ViewedTabList = {
  person: TabListPerson
  /** The tab this window shows from their list; null, the one their list has active. */
  picked: ViewedTabPick | null
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
  views.set(homeKey, { person, picked: null })
  changed()
}

/** Shows one of their tabs here; their own pick stays theirs. */
export function pickViewedTab(homeKey: string, picked: ViewedTabPick): void {
  const current = views.get(homeKey)
  if (current) {
    views.set(homeKey, { ...current, picked })
    changed()
  }
}

/** The list a chat is in, as the agent's host names whose it is (`person`, unset for the owner's). */
export function chatTabListPerson(chat: { person?: { accountId: string } }): TabListPerson {
  return chat.person ? { accountId: chat.person.accountId } : 'owner'
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useViewedTabList(homeKey: string | null): ViewedTabList | null {
  return useSyncExternalStore(subscribe, () => (homeKey ? (views.get(homeKey) ?? null) : null))
}

/** A chat opened from Chats while this window shows someone's tabs: theirs shows in their strip;
 *  anyone else's leaves the view, to open in this window's own tabs as usual. True when shown. */
export function showChatInViewedTabList(
  homeKey: string,
  chat: { chatId: string; person?: { accountId: string } }
): boolean {
  const view = views.get(homeKey)
  if (!view) {
    return false
  }
  if (sameTabListPerson(view.person, chatTabListPerson(chat))) {
    pickViewedTab(homeKey, { sessionId: chat.chatId })
    return true
  }
  viewTabList(homeKey, null)
  return false
}
