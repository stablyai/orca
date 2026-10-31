import { useSyncExternalStore } from 'react'
import type { NativeChatDefaultSettings } from '../../../shared/structured-native-chat-launch-route'
import { isWebClientLocation } from '@/lib/web-client-location'
import { useAppStore } from '@/store'
import { restoreLocalStructuredSessionTabsOnce } from './local-structured-session-tabs-sync/inventory-refresh'

// Mirror existing local chats regardless of new-launch settings. Host construction alone proves no chats (history/phone also builds it); only held records justify mirror cost. Browser clients have no own runtime.

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

type StructuredChatSettings = NativeChatDefaultSettings | null

/** Either the default or an explicit exception can open new chats. */
export function newAgentLaunchesMayOpenChats(
  settings: StructuredChatSettings | undefined
): boolean {
  return (
    settings?.agentDefaultSurface === 'chat' ||
    Object.values(settings?.nativeChatProviders ?? {}).some((on) => on === true)
  )
}

function chatsInUse(launchesChats: boolean, holds: boolean): boolean {
  return !isWebClientLocation() && (launchesChats || holds)
}

/** Structured chats can exist on this machine: new launches open them, or the runtime holds some. */
export function useLocalStructuredChatsInUse(): boolean {
  const holds = useLocalStructuredAgentSessionsHeld()
  const launchesChats = useAppStore((state) => newAgentLaunchesMayOpenChats(state.settings))
  return chatsInUse(launchesChats, holds)
}

/** The same answer for one-shot startup work, asked of the host rather than read from the renderer. */
export async function localStructuredChatsInUse(
  settings: StructuredChatSettings | undefined
): Promise<boolean> {
  if (isWebClientLocation()) {
    return false
  }
  return chatsInUse(
    newAgentLaunchesMayOpenChats(settings),
    await readLocalStructuredAgentSessionsHeld()
  )
}

/**
 * Startup's restore of this machine's chats. Existing chats come back whatever the Chat | CLI
 * choices say; a machine that holds none, or the browser client, runs no session-tab census for them.
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
