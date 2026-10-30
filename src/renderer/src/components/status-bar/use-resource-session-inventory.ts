import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { subscribeDaemonSessionInventoryInvalidated } from './daemon-session-inventory-invalidation'
import { ResourceSessionInventoryCache } from './resource-session-inventory-cache'
import type { PtyListedSession } from '../../../../shared/pty-listed-session'

export function useResourceSessionInventory(ready: boolean, active = false, localOnly = false) {
  const [cache] = useState(
    () =>
      new ResourceSessionInventoryCache(
        () =>
          window.api.pty.listSessions(
            localOnly ? { connectionId: null, includeUnrouted: true } : undefined,
            {
              resourceManagerView: true
            }
          ),
        localOnly
      )
  )
  const state = useSyncExternalStore(cache.subscribe, cache.getSnapshot)
  useEffect(() => {
    cache.setActive(ready && active)
    return () => cache.setActive(false)
  }, [cache, ready, active])
  useEffect(() => {
    const unsubscribeManagement = subscribeDaemonSessionInventoryInvalidated(cache.invalidate)
    const unsubscribeSpawn = window.api.pty.onSpawned((event) => cache.spawned(event))
    const unsubscribeExit = window.api.pty.onExit((event) => cache.exited(event))
    return () => {
      unsubscribeManagement()
      unsubscribeSpawn()
      unsubscribeExit()
    }
  }, [cache])
  const removeSession = useCallback(
    (id: string, incarnationId?: string) => cache.remove(id, incarnationId),
    [cache]
  )
  const removeSessions = useCallback(
    (sessions: readonly Pick<PtyListedSession, 'id' | 'incarnationId'>[]) =>
      cache.removeMany(sessions),
    [cache]
  )
  return {
    ...state,
    refreshSessions: cache.refresh,
    clearSessionsError: cache.clearError,
    invalidate: cache.invalidate,
    removeSession,
    removeSessions
  }
}
