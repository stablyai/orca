// Whose tabs this window shows in a shared agent's Home: its own (no entry) or another person's list,
// and which of their tabs it shows. Window-local and never saved: viewing writes nothing anywhere.
import { useSyncExternalStore } from 'react'
import type { z } from 'zod'
import type { SessionTabListPerson } from '../../../../../shared/rpc-contract/session-tabs/session-tab-list-person-params'

export type TabListPerson = z.infer<typeof SessionTabListPerson>

/** A tab picked here from their list: by its id (their strip), or a chat by its session (Chats). */
export type ViewedTabPick = { tabId: string } | { sessionId: string }

export type PersonTabListView = {
  person: TabListPerson
  /** The tab this window shows from their list; null, the one their list has active. */
  picked: ViewedTabPick | null
}

/** Another person's tabs, or (`person` null) a chat whose person this window can't tell: shown to
 *  read alone, never placed in this window's own tabs. */
export type ViewedTabList = PersonTabListView | { person: null; picked: { sessionId: string } }

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

/** Shows `person`'s tabs in the Home (and `picked` of them), or with null this window's own again. */
export function viewTabList(
  homeKey: string,
  person: TabListPerson | null,
  picked: ViewedTabPick | null = null
): void {
  const current = views.get(homeKey)
  if (person === null) {
    if (current && views.delete(homeKey)) {
      changed()
    }
    return
  }
  if (current?.person && sameTabListPerson(current.person, person) && picked === null) {
    return
  }
  views.set(homeKey, { person, picked })
  changed()
}

/** Whether this window shows another list (or a chat to read) over its own tabs in `homeKey`. */
export function hasViewedTabList(homeKey: string): boolean {
  return views.has(homeKey)
}

/** Whether this window's own tabs in `worktreeId` are covered by another list: closing or moving one
 *  of them there, unseen, is no act of the person pressing keys. */
export function ownTabsHiddenIn(worktreeId: string | null): boolean {
  return worktreeId !== null && views.has(worktreeId)
}

/** One of this window's own tabs became the one shown, by a person's activation or create (the
 *  store's `activateTab` and tab creates): its own tabs show again. A background update
 *  (`recordFocus: false`) leaves a view as it is. */
export function leaveViewedTabList(homeKey: string): void {
  viewTabList(homeKey, null)
}

/** Shows a chat to read whose person this window can't tell, over its own tabs. */
export function viewChatOfUnknownPerson(homeKey: string, sessionId: string): void {
  views.set(homeKey, { person: null, picked: { sessionId } })
  changed()
}

/** Shows one of their tabs here (null: the one their list has active); their own pick stays theirs. */
export function pickViewedTab(homeKey: string, picked: ViewedTabPick | null): void {
  const current = views.get(homeKey)
  if (current?.person) {
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
