// Display-only mirror of main's agent activity; main decides which pages agents drive.
import { useSyncExternalStore } from 'react'
import type { BrowserAgentCursorEvent } from '../../../../../shared/browser-agent-activity-contract'

/** A mounted page draws the cursor and glow; `show` says whether it will report the arrival. */
type BrowserAgentCursorSink = {
  show: (event: BrowserAgentCursorEvent) => boolean
  setActive: (active: boolean) => void
}

const activePageIds = new Set<string>()
/** The SSH host driving a page through the desktop browser bridge, by its label. */
const controllerHostByPage = new Map<string, string>()
/** Activity no chat claimed: older CLIs, remote hosts and terminal agents. */
const lastUnclaimedPageIdByWorktree = new Map<string, string>()
const lastPageIdByChatSession = new Map<string, string>()
const lastCursorByPage = new Map<string, BrowserAgentCursorEvent>()
const sinksByPage = new Map<string, BrowserAgentCursorSink>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setBrowserAgentPageActive(
  browserPageId: string,
  active: boolean,
  worktreeId: string | null,
  controllerHostLabel?: string,
  agentSessionId?: string
): void {
  if (active) {
    activePageIds.add(browserPageId)
    if (controllerHostLabel) {
      controllerHostByPage.set(browserPageId, controllerHostLabel)
    } else {
      controllerHostByPage.delete(browserPageId)
    }
    if (agentSessionId) {
      lastPageIdByChatSession.set(agentSessionId, browserPageId)
    } else if (worktreeId) {
      lastUnclaimedPageIdByWorktree.set(worktreeId, browserPageId)
    }
  } else {
    activePageIds.delete(browserPageId)
    controllerHostByPage.delete(browserPageId)
    lastCursorByPage.delete(browserPageId)
  }
  sinksByPage.get(browserPageId)?.setActive(active)
  notify()
}

/** Answers whether a mounted, visible page took the cursor; false means nobody will see it. */
export function showBrowserAgentCursor(event: BrowserAgentCursorEvent): boolean {
  lastCursorByPage.set(event.browserPageId, event)
  return sinksByPage.get(event.browserPageId)?.show(event) ?? false
}

/** Registers the page's agent layer, lit if an agent drives the page, cursor where it last acted. */
export function attachBrowserAgentCursorSink(
  browserPageId: string,
  sink: BrowserAgentCursorSink
): () => void {
  sinksByPage.set(browserPageId, sink)
  const active = activePageIds.has(browserPageId)
  sink.setActive(active)
  const last = lastCursorByPage.get(browserPageId)
  if (last && active) {
    sink.show({ ...last, press: false, awaitsArrival: false })
  }
  return () => {
    if (sinksByPage.get(browserPageId) === sink) {
      sinksByPage.delete(browserPageId)
    }
  }
}

export function useBrowserAgentDrivesAnyPage(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  const drives = (): boolean => browserPageIds.some((id) => id != null && activePageIds.has(id))
  return useSyncExternalStore(subscribe, drives, drives)
}

/** The SSH host controlling any of these pages, or null when none is (or a local agent is). */
export function useBrowserAgentControllerHost(
  browserPageIds: readonly (string | null | undefined)[]
): string | null {
  const read = (): string | null => {
    for (const id of browserPageIds) {
      const host = id != null && activePageIds.has(id) ? controllerHostByPage.get(id) : undefined
      if (host) {
        return host
      }
    }
    return null
  }
  return useSyncExternalStore(subscribe, read, read)
}

/** The page this chat's agent drove most recently; until it has claimed any, what an unclaimed agent in its worktree drove. */
export function useLastBrowserAgentPageId(
  worktreeId: string | null,
  chatSessionId: string | null
): string | null {
  // A chat that claimed activity names itself on this host, so unclaimed activity is another agent's.
  const read = (): string | null =>
    (chatSessionId ? lastPageIdByChatSession.get(chatSessionId) : undefined) ??
    (worktreeId ? lastUnclaimedPageIdByWorktree.get(worktreeId) : undefined) ??
    null
  return useSyncExternalStore(subscribe, read, read)
}
