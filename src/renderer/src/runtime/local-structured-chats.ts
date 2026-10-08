import { useSyncExternalStore } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { restoreLocalStructuredSessionTabsOnce } from './local-structured-session-tabs-sync/inventory-refresh'

// Whether THIS machine's runtime holds a structured chat (a saved record, or one a client created
// here), as main derives it from the host's records. Building the host alone is not holding one:
// session history and phone launches build it too. The chat setting picks what new launches open
// as, so the chats that exist show whatever it says; a machine that holds none pays for no chat
// mirror. The browser client has no runtime of its own.

let held = false
let pushes = 0
const listeners = new Set<() => void>()
let stopListening: (() => void) | null = null

function setHeld(next: boolean): void {
  if (held === next) {
    return
  }
  held = next
  for (const listener of listeners) {
    listener()
  }
}

function onHeldChanged(next: boolean): void {
  pushes += 1
  setHeld(next)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  // Why optional: a window without the desktop bridge has no runtime to hold chats.
  const app = typeof window === 'undefined' ? undefined : window.api?.app
  if (!stopListening && app && !isWebClientLocation()) {
    stopListening = app.onStructuredAgentSessionsHeldChanged(onHeldChanged)
    void readLocalStructuredAgentSessionsHeld()
  }
  return () => {
    listeners.delete(listener)
  }
}

/** Asks this machine's runtime whether it holds a structured chat. */
export async function readLocalStructuredAgentSessionsHeld(): Promise<boolean> {
  if (isWebClientLocation()) {
    return false
  }
  const pushesBefore = pushes
  try {
    const answer = (await window.api?.app?.holdsStructuredAgentSessions()) === true
    // A change pushed while the query was in flight is newer than its answer.
    if (pushes === pushesBefore) {
      setHeld(answer)
    }
  } catch {
    // An unanswered query is not an answer; the change event still arrives.
  }
  return held
}

/** This machine's runtime holds a structured chat. */
export function useLocalStructuredAgentSessionsHeld(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => held,
    () => false
  )
}

type StructuredChatSettings = Pick<GlobalSettings, 'experimentalStructuredNativeChat'> | null

function chatsInUse(settings: StructuredChatSettings | undefined, holds: boolean): boolean {
  return !isWebClientLocation() && (settings?.experimentalStructuredNativeChat === true || holds)
}

/** Structured chats can exist on this machine: the setting launches them, or the runtime holds some. */
export function useLocalStructuredChatsInUse(): boolean {
  const holds = useLocalStructuredAgentSessionsHeld()
  const setting = useAppStore((state) => state.settings?.experimentalStructuredNativeChat === true)
  return chatsInUse({ experimentalStructuredNativeChat: setting }, holds)
}

/** The same answer for one-shot startup work, asked of the host rather than read from the renderer. */
export async function localStructuredChatsInUse(
  settings: StructuredChatSettings | undefined
): Promise<boolean> {
  if (isWebClientLocation()) {
    return false
  }
  return chatsInUse(settings, await readLocalStructuredAgentSessionsHeld())
}

/**
 * Startup's restore of this machine's chats. Existing chats come back whatever the chat setting
 * says; a machine that holds none, or the browser client, runs no session-tab census for them.
 */
export async function restoreLocalStructuredChatsAtStartup(
  settings: StructuredChatSettings | undefined,
  runStep: (restore: () => Promise<void>) => Promise<unknown>
): Promise<void> {
  if (await localStructuredChatsInUse(settings)) {
    await runStep(() => restoreLocalStructuredSessionTabsOnce())
  }
}

/** @internal - tests need a clean module between cases. */
export function resetLocalStructuredChatsForTests(): void {
  stopListening?.()
  stopListening = null
  held = false
  pushes = 0
  listeners.clear()
}
