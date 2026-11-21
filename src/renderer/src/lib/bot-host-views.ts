// Each bot host's state for views, apart from bot-catalog so a row reads it without loading the list.
import { useCallback, useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import {
  isDocumentVisibilityProvenStale,
  registerStaleDocumentVisibilityRecovery
} from '@/components/terminal-pane/viewport/visibility/stale-document-visibility'
import { readBotHostState, readLiveBotHostIds, subscribeToBotChanges } from './bot-catalog-snapshot'

/** Whether the host's bots show from its last read because it is disconnected. */
export function useBotHostOffline(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readBotHostState(hostId) === 'offline'
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}

// Per-host liveness for rows: one catalog subscription for all of them, and a host's listeners hear only
// that host changing. Only watched hosts are looked at, each by its own entry, so other hosts coming or
// going (or any other bot change) cost nothing. While the window is hidden rows read nothing: hosts keep
// the state they had, and a host that went away meanwhile is heard as changed once it shows.
/** `wentAway`: the host was gone at some point since last heard (it may be back by now). */
type HostListener = (wentAway: boolean) => void
type Watched = { live: boolean; left: boolean; listeners: Set<HostListener> }
const watched = new Map<ExecutionHostId, Watched>()
let liveSeen: readonly ExecutionHostId[] | null = null
let stopCatalog: (() => void) | null = null
let wasHidden = false

const hidden = (): boolean => document.hidden && !isDocumentVisibilityProvenStale()
const liveNow = (hostId: ExecutionHostId): boolean => readBotHostState(hostId) === 'live'

function onCatalog(): void {
  const ids = readLiveBotHostIds()
  if (ids === liveSeen) {
    return
  }
  liveSeen = ids
  const shown = !hidden()
  watched.forEach((host, hostId) => {
    const live = liveNow(hostId)
    host.left ||= !live
    if (shown && (live !== host.live || host.left)) {
      const wentAway = host.left
      host.live = live
      host.left = false
      host.listeners.forEach((listener) => listener(wentAway))
    }
  })
}

const onVisibility = (): void => {
  const now = hidden()
  if (now === wasHidden) {
    return
  }
  wasHidden = now
  liveSeen = null
  if (!now) {
    onCatalog()
  }
  watched.forEach((host) => host.listeners.forEach((listener) => listener(false)))
}

/** Calls `listener` when the host comes or goes (or went away while the window was hidden, once it
 *  shows) and as the window shows or hides; returns the leave. */
export function subscribeToBotHostLive(
  hostId: ExecutionHostId,
  listener: HostListener
): () => void {
  if (!stopCatalog) {
    wasHidden = hidden()
    liveSeen = readLiveBotHostIds()
    const stopBots = subscribeToBotChanges(onCatalog)
    document.addEventListener('visibilitychange', onVisibility)
    // After display wake the window can stay wrongly `hidden`; input proving it shown catches up too.
    const stopStale = registerStaleDocumentVisibilityRecovery(onVisibility)
    stopCatalog = () => {
      stopBots()
      stopStale()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
  const host = watched.get(hostId) ?? { live: liveNow(hostId), left: false, listeners: new Set() }
  watched.set(hostId, host)
  host.listeners.add(listener)
  return () => {
    host.listeners.delete(listener)
    if (host.listeners.size === 0 && watched.get(hostId) === host) {
      watched.delete(hostId)
    }
    if (watched.size === 0) {
      stopCatalog?.()
      stopCatalog = null
    }
  }
}

/** The host's state as rows see it: as it was while the window is hidden. */
export function isBotHostLive(hostId: ExecutionHostId): boolean {
  return watched.get(hostId)?.live ?? liveNow(hostId)
}

const subscribeToNothing = (): (() => void) => () => {}
const alwaysLive = (): boolean => true

/** Whether a row on the host can read now (the host live and the window shown), heard only when that
 *  host or the window changes; true when not `enabled`. */
export function useBotHostLive(hostId: ExecutionHostId, enabled: boolean): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToBotHostLive(hostId, () => listener()),
    [hostId]
  )
  const read = useCallback(() => !hidden() && isBotHostLive(hostId), [hostId])
  return useSyncExternalStore(
    enabled ? subscribe : subscribeToNothing,
    enabled ? read : alwaysLive,
    enabled ? read : alwaysLive
  )
}
