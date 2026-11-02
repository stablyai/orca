// Display-only mirror of main's agent activity; main decides which pages agents drive.
import { useSyncExternalStore } from 'react'
import type { BrowserAgentCursorEvent } from '../../../../../shared/browser-agent-activity-contract'

/** A mounted page draws the cursor and glow; `show` says whether it will report the arrival. */
type BrowserAgentCursorSink = {
  show: (event: BrowserAgentCursorEvent) => boolean
  setActive: (active: boolean) => void
}

/** The page an agent in a worktree last drove; `revision` orders it against other activity. */
type BrowserAgentActivityMark = { pageId: string; revision: number }

const activePageIds = new Set<string>()
const lastActivityByWorktree = new Map<string, BrowserAgentActivityMark>()
const lastCursorByPage = new Map<string, BrowserAgentCursorEvent>()
const sinksByPage = new Map<string, BrowserAgentCursorSink>()
const listeners = new Set<() => void>()
let revision = 0

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
  worktreeId: string | null
): void {
  if (active) {
    revision += 1
    activePageIds.add(browserPageId)
    if (worktreeId) {
      lastActivityByWorktree.set(worktreeId, { pageId: browserPageId, revision })
    }
  } else {
    activePageIds.delete(browserPageId)
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

/** Activity that arrives later than this revision happened after the caller looked. */
export function getBrowserAgentActivityRevision(): number {
  return revision
}

export function useBrowserAgentDrivesAnyPage(
  browserPageIds: readonly (string | null | undefined)[]
): boolean {
  const drives = (): boolean => browserPageIds.some((id) => id != null && activePageIds.has(id))
  return useSyncExternalStore(subscribe, drives, drives)
}

/** What an agent in this worktree drove most recently, while this window has been open. */
export function useLastBrowserAgentActivity(
  worktreeId: string | null
): BrowserAgentActivityMark | null {
  const read = (): BrowserAgentActivityMark | null =>
    worktreeId ? (lastActivityByWorktree.get(worktreeId) ?? null) : null
  return useSyncExternalStore(subscribe, read, read)
}
