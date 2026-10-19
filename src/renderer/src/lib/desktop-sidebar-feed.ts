import { useEffect, useSyncExternalStore } from 'react'
import {
  INITIAL_SIDEBAR_INPUTS_FEED_STATE,
  refreshSidebarInputs,
  sidebarInputsChanged,
  sidebarInputsReadFailed,
  sidebarInputsReplied,
  type SidebarInputsFeedRequest,
  type SidebarInputsFeedState,
  type SidebarInputsFeedStep
} from '../../../shared/sidebar-list/sidebar-inputs-feed-installer'
import { SidebarInputsReadResultSchema } from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import {
  readSidebarFeedDomains,
  type SidebarFeedDomains,
  type SidebarFeedRead
} from '../../../shared/sidebar-list/sidebar-feed-domains'

/** Main's sidebar inputs as this window last installed them. */
export type DesktopSidebarFeed = {
  domains: SidebarFeedDomains
  /** The read this install answered: it reflects every write main had answered before it was sent. */
  readId: number
}

// A failed read (main still starting) retries on its own: no notice may follow for a while.
const RETRY_MS = 1_000

let state: SidebarInputsFeedState = INITIAL_SIDEBAR_INPUTS_FEED_STATE
let read: SidebarFeedRead | null = null
let feed: DesktopSidebarFeed | null = null
let readers = 0
let detachNotices: (() => void) | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
const installListeners = new Set<(installed: DesktopSidebarFeed) => void>()

function advance(step: SidebarInputsFeedStep): void {
  state = step.state
  if (step.request) {
    void send(step.request)
  }
}

async function send(request: SidebarInputsFeedRequest): Promise<void> {
  const response = await window.api.runtime
    .call({ method: 'sidebarInputs.read', params: request.params })
    .catch(() => null)
  const reply = response?.ok ? SidebarInputsReadResultSchema.safeParse(response.result) : null
  if (!reply?.success) {
    if (state.inFlight !== request.id) {
      return
    }
    state = sidebarInputsReadFailed(state, request.id)
    retryTimer ??= setTimeout(() => {
      retryTimer = null
      if (readers > 0 && state.inFlight === null) {
        advance(refreshSidebarInputs(state))
      }
    }, RETRY_MS)
    return
  }
  const answered = state.inFlight === request.id
  const step = sidebarInputsReplied(state, request.id, reply.data)
  advance(step)
  const { installed } = state
  // Settled with nothing more to read: what is installed is current as of this read.
  if (answered && !step.request && installed) {
    const domains =
      read?.installed === installed
        ? read.domains
        : readSidebarFeedDomains(installed, read ?? undefined)
    read = { installed, domains }
    const next = { domains, readId: request.id }
    feed = next
    installListeners.forEach((listener) => listener(next))
    listeners.forEach((listener) => listener())
  }
}

/** Runs on every install, before the sidebar re-renders from it. */
export function onDesktopSidebarFeedInstalled(
  listener: (installed: DesktopSidebarFeed) => void
): () => void {
  installListeners.add(listener)
  return () => installListeners.delete(listener)
}

/** Reads again now, so the next install reflects every write main has answered so far. */
export function refreshDesktopSidebarFeed(): number {
  if (readers === 0) {
    // Nothing is read now; the next mount's first read is the earliest that shows the write.
    return state.lastRequestId + 1
  }
  advance(refreshSidebarInputs(state))
  return state.lastRequestId
}

function acquire(): () => void {
  readers += 1
  if (readers === 1) {
    detachNotices = window.api.runtime.onSidebarInputsChanged((notice) =>
      advance(sidebarInputsChanged(state, notice))
    )
    advance(refreshSidebarInputs(state))
  }
  return () => {
    readers -= 1
    if (readers === 0) {
      detachNotices?.()
      detachNotices = null
    }
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Null until main's first install lands. Only an ORCA_SIDEBAR_INPUTS=main window reads this. */
export function useDesktopSidebarFeed(): DesktopSidebarFeed | null {
  useEffect(acquire, [])
  return useSyncExternalStore(subscribe, () => feed)
}
