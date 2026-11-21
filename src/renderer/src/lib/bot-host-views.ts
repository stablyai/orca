// Each bot host's state for views, apart from bot-catalog so a row reads it without loading the list.
import { useCallback, useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import { readBotHostState, readLiveBotHostIds, subscribeToBotChanges } from './bot-catalog-snapshot'

/** Whether the host's bots show from its last read because it is disconnected. */
export function useBotHostOffline(hostId: ExecutionHostId): boolean {
  const read = (): boolean => readBotHostState(hostId) === 'offline'
  return useSyncExternalStore(subscribeToBotChanges, read, read)
}

// Per-host liveness for rows: one catalog subscription for all of them, and a host's rows hear only that
// host changing, so another host coming or going (or any other bot change) reaches none of them.
const hostListeners = new Map<ExecutionHostId, Set<() => void>>()
const anyListeners = new Set<() => void>()
let liveSeen: readonly ExecutionHostId[] | null = null
let liveSet: ReadonlySet<ExecutionHostId> = new Set()
let stopCatalog: (() => void) | null = null

// While the window is hidden rows keep the hosts as they were, so a host coming back reads nothing
// until the window shows again.
const hidden = (): boolean => document.hidden

function currentLive(): ReadonlySet<ExecutionHostId> {
  if (liveSeen !== null && stopCatalog !== null && hidden()) {
    return liveSet
  }
  const ids = readLiveBotHostIds()
  if (ids !== liveSeen) {
    liveSeen = ids
    liveSet = new Set(ids)
  }
  return liveSet
}

function onCatalog(): void {
  const was = liveSet
  const seen = liveSeen
  const now = currentLive()
  if (liveSeen === seen) {
    return
  }
  const changed = [...hostListeners.keys()].filter((hostId) => now.has(hostId) !== was.has(hostId))
  changed.forEach((hostId) => hostListeners.get(hostId)?.forEach((listener) => listener()))
  if (now.size !== was.size || [...now].some((hostId) => !was.has(hostId))) {
    anyListeners.forEach((listener) => listener())
  }
}

const onVisibility = (): void => {
  if (!hidden()) {
    onCatalog()
  }
}

function listen(): () => void {
  currentLive()
  if (!stopCatalog) {
    const stopBots = subscribeToBotChanges(onCatalog)
    document.addEventListener('visibilitychange', onVisibility)
    stopCatalog = () => {
      stopBots()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }
  return () => {
    if (hostListeners.size === 0 && anyListeners.size === 0) {
      stopCatalog?.()
      stopCatalog = null
    }
  }
}

function subscribeToHostLive(hostId: ExecutionHostId, listener: () => void): () => void {
  const listeners = hostListeners.get(hostId) ?? new Set<() => void>()
  hostListeners.set(hostId, listeners)
  listeners.add(listener)
  const stop = listen()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && hostListeners.get(hostId) === listeners) {
      hostListeners.delete(hostId)
    }
    stop()
  }
}

/** Calls `listener` when any host comes or goes; returns the leave. */
export function subscribeToLiveBotHosts(listener: () => void): () => void {
  anyListeners.add(listener)
  const stop = listen()
  return () => {
    anyListeners.delete(listener)
    stop()
  }
}

export function isBotHostLive(hostId: ExecutionHostId): boolean {
  return currentLive().has(hostId)
}

const subscribeToNothing = (): (() => void) => () => {}
const alwaysLive = (): boolean => true

/** Whether the host can be called now, heard only when that host changes; true when not `enabled`. */
export function useBotHostLive(hostId: ExecutionHostId, enabled: boolean): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToHostLive(hostId, listener),
    [hostId]
  )
  const read = useCallback(() => isBotHostLive(hostId), [hostId])
  return useSyncExternalStore(
    enabled ? subscribe : subscribeToNothing,
    enabled ? read : alwaysLive,
    enabled ? read : alwaysLive
  )
}
