import { useEffect, useSyncExternalStore } from 'react'
import { SidebarInputsReadResultSchema } from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import {
  SidebarFeedReader,
  type SidebarFeedReaderRead,
  type SidebarFeedTransport
} from '../../../shared/sidebar-feed-client/sidebar-feed-reader'

/** Main's sidebar inputs as this window last installed them. */
export type DesktopSidebarFeed = {
  domains: SidebarFeedDomains
  /** The read this install answered: it reflects every write main had answered before it was sent. */
  readId: number
}

// A failed read (main still starting) retries on its own: no notice may follow for a while.
const RETRY_MS = 1_000

const readFromMain: SidebarFeedTransport = async (params) => {
  const response = await window.api.runtime
    .call({ method: 'sidebarInputs.read', params })
    .catch(() => null)
  const reply = response?.ok ? SidebarInputsReadResultSchema.safeParse(response.result) : null
  return reply?.success ? { kind: 'answered', reply: reply.data } : { kind: 'failed' }
}

let feed: DesktopSidebarFeed | null = null
let reader: SidebarFeedReader | null = null
const listeners = new Set<() => void>()
const installListeners = new Set<(installed: DesktopSidebarFeed) => void>()

// Draws only a settled install: one with nothing more to read is current as of its read.
function installed({ snapshot, settledBy }: SidebarFeedReaderRead): void {
  if (!snapshot || settledBy === null) {
    return
  }
  const next = { domains: snapshot.domains, readId: settledBy }
  feed = next
  installListeners.forEach((listener) => listener(next))
  listeners.forEach((listener) => listener())
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
  // Nothing is read yet; the first mount's first read is the earliest that shows the write.
  return reader ? reader.refresh() : 1
}

/** Follows main from the first mount for the window's life: main serves this window until it closes
 *  either way, and a list that remounts must not first draw rows main changed while it was hidden. */
function start(): void {
  if (reader) {
    return
  }
  const started = new SidebarFeedReader(readFromMain, { retryDelayMs: () => RETRY_MS }, installed)
  reader = started
  window.api.runtime.onSidebarInputsChanged((notice) => started.changed(notice))
  started.refresh()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Null until main's first install lands. Only an ORCA_SIDEBAR_INPUTS=main window reads this. */
export function useDesktopSidebarFeed(): DesktopSidebarFeed | null {
  useEffect(start, [])
  return useSyncExternalStore(subscribe, () => feed)
}
