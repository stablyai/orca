import { useSyncExternalStore } from 'react'

type Children = { workspaces: boolean; chats: boolean; available: boolean }
const rows = new Map<string, Children>()
const listeners = new Set<() => void>()
let snapshot = botSidebarHasChildren

export function botSidebarHasChildren(key: string): boolean {
  const row = rows.get(key)
  return !!row?.available && (row.workspaces || row.chats)
}

export function hasBotSidebarChildPresence(key: string): boolean {
  return rows.has(key)
}

function publish(): void {
  snapshot = (key) => botSidebarHasChildren(key)
  for (const listener of listeners) {
    listener()
  }
}

/** Keep the last known chat presence when folding unmounts its reader; never start another read. */
export function setBotSidebarChildren(key: string, update: Partial<Children>): void {
  const before = botSidebarHasChildren(key)
  rows.set(key, { workspaces: false, chats: false, available: true, ...rows.get(key), ...update })
  if (before !== botSidebarHasChildren(key)) {
    publish()
  }
}

export function pruneBotSidebarChildren(liveKeys: ReadonlySet<string>): void {
  let changed = false
  for (const key of rows.keys()) {
    if (!liveKeys.has(key)) {
      changed = botSidebarHasChildren(key) || changed
      rows.delete(key)
    }
  }
  if (changed) {
    publish()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBotSidebarChildren(): typeof botSidebarHasChildren {
  return useSyncExternalStore(subscribe, () => snapshot)
}
