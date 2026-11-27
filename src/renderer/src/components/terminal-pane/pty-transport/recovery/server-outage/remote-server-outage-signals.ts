import { useEffect, useSyncExternalStore } from 'react'

/** Window-local signals between a server's card and its veiled panes and tabs. */
const nudges = new Map<string, number>()
const downTabs = new Map<string, number>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** A click on a veiled pane points the user at the card that explains it. */
export function nudgeRemoteServerOutageCard(environmentId: string): void {
  nudges.set(environmentId, (nudges.get(environmentId) ?? 0) + 1)
  notify()
}

/** Counts this server's nudges; a change means play the nudge once. */
export function useRemoteServerOutageNudge(environmentId: string): number {
  return useSyncExternalStore(subscribe, () => nudges.get(environmentId) ?? 0)
}

/** Marks a tab while at least one of its panes is on a down server. */
export function usePublishRemoteServerDownTab(tabId: string, down: boolean): void {
  useEffect(() => {
    if (!down) {
      return
    }
    downTabs.set(tabId, (downTabs.get(tabId) ?? 0) + 1)
    notify()
    return () => {
      const count = (downTabs.get(tabId) ?? 1) - 1
      if (count > 0) {
        downTabs.set(tabId, count)
      } else {
        downTabs.delete(tabId)
      }
      notify()
    }
  }, [down, tabId])
}

export function useTabHasDownServer(tabId: string): boolean {
  return useSyncExternalStore(subscribe, () => downTabs.has(tabId))
}
