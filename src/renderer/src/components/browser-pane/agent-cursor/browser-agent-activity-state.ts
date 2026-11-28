// Display-only mirror of which pages agents drive: main's for its own pages, a paired host's rows for pages it runs.
import { useSyncExternalStore } from 'react'
import type {
  BrowserAgentCursorEvent,
  BrowserAgentPointerPoint
} from '../../../../../shared/browser/automation/browser-agent-activity-contract'

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

const MAX_TRACKED_LAST_PAGES = 200

function setBoundedLastPage(map: Map<string, string>, key: string, browserPageId: string): void {
  map.delete(key)
  map.set(key, browserPageId)
  if (map.size > MAX_TRACKED_LAST_PAGES) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) {
      map.delete(oldest)
    }
  }
}

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
      setBoundedLastPage(lastPageIdByChatSession, agentSessionId, browserPageId)
    } else if (worktreeId) {
      setBoundedLastPage(lastUnclaimedPageIdByWorktree, worktreeId, browserPageId)
    }
  } else {
    activePageIds.delete(browserPageId)
    controllerHostByPage.delete(browserPageId)
    lastCursorByPage.delete(browserPageId)
  }
  sinksByPage.get(browserPageId)?.setActive(active)
  notify()
}

/** Applies a paired host's agent mark for a page it runs; unchanged marks notify nobody. */
export function mirrorBrowserAgentPageActive(
  browserPageId: string,
  active: boolean,
  worktreeId: string
): void {
  if (activePageIds.has(browserPageId) !== active) {
    setBrowserAgentPageActive(browserPageId, active, worktreeId)
  }
}

/** Shows a streamed page's agent pointer; its host never waits on this viewer, so no arrival is reported. */
export function createStreamedBrowserAgentCursor(
  getBrowserPageId: () => string
): (point: BrowserAgentPointerPoint) => void {
  let sequence = 0
  return (point) => {
    showBrowserAgentCursor({
      ...point,
      browserPageId: getBrowserPageId(),
      sequence: ++sequence,
      awaitsArrival: false
    })
  }
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

/** Drop cached activity state referencing a closed browser page. */
export function forgetBrowserAgentPage(browserPageId: string): void {
  let changed = activePageIds.delete(browserPageId)
  changed = controllerHostByPage.delete(browserPageId) || changed
  lastCursorByPage.delete(browserPageId)
  for (const [sessionId, pageId] of lastPageIdByChatSession) {
    if (pageId === browserPageId) {
      lastPageIdByChatSession.delete(sessionId)
      changed = true
    }
  }
  for (const [worktreeId, pageId] of lastUnclaimedPageIdByWorktree) {
    if (pageId === browserPageId) {
      lastUnclaimedPageIdByWorktree.delete(worktreeId)
      changed = true
    }
  }
  if (changed) {
    notify()
  }
}

/** Drop unclaimed browser activity cached for a removed workspace. */
export function forgetBrowserAgentWorktree(worktreeId: string): void {
  if (lastUnclaimedPageIdByWorktree.delete(worktreeId)) {
    notify()
  }
}
