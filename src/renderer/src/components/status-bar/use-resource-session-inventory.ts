import { useCallback, useEffect, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  EMPTY_DAEMON_SESSION_INVENTORY,
  inventoryFromSessionIds,
  inventoryFromSessions,
  removeSessionFromInventory,
  removeSessionsFromInventory,
  type DaemonSessionInventory
} from './resource-session-inventory'

type ResourceSessionInventory = {
  sessionInventory: DaemonSessionInventory
  sessionsError: boolean
  refreshSessions: () => Promise<void>
  clearSessionsError: () => void
  removeSession: (sessionId: string) => void
  removeSessions: (sessionIds: ReadonlySet<string>) => void
}

type ResourceSessionInventoryState = {
  ready: boolean
  sessionInventory: DaemonSessionInventory
  sessionsError: boolean
}

export function useResourceSessionInventory(
  ready: boolean,
  detailsEnabled: boolean
): ResourceSessionInventory {
  const mountedRef = useMountedRef()
  const refreshGenerationRef = useRef(0)
  const sessionIdRefreshRef = useRef<{ generation: number; promise: Promise<void> } | null>(null)
  const previousDetailsEnabledRef = useRef(detailsEnabled)
  const lifecycleRevisionRef = useRef(0)
  const removedAtRevisionRef = useRef(new Map<string, number>())
  const knownSessionIdsRef = useRef(new Set<string>())
  const [storedState, setStoredState] = useState<ResourceSessionInventoryState>(() => ({
    ready,
    sessionInventory: EMPTY_DAEMON_SESSION_INVENTORY,
    sessionsError: false
  }))
  const state =
    storedState.ready === ready
      ? storedState
      : {
          ready,
          sessionInventory: EMPTY_DAEMON_SESSION_INVENTORY,
          sessionsError: false
        }
  if (state !== storedState) {
    // Why: readiness changes define a new inventory epoch. Reset during render
    // so an old workspace count is never exposed for one committed frame.
    setStoredState(state)
  }

  const commitInventory = useCallback(
    (
      generation: number,
      lifecycleRevision: number,
      sessionIds: readonly string[],
      sessions?: readonly DaemonSessionInventory['sessions'][number][]
    ): void => {
      if (!mountedRef.current || generation !== refreshGenerationRef.current) {
        return
      }
      const currentRemovedAtRevision = removedAtRevisionRef.current
      const liveIds = sessionIds.filter(
        (id) => (currentRemovedAtRevision.get(id) ?? 0) <= lifecycleRevision
      )
      const liveIdSet = new Set(liveIds)
      for (const [id, removedAtRevision] of currentRemovedAtRevision) {
        if (removedAtRevision <= lifecycleRevision) {
          currentRemovedAtRevision.delete(id)
        }
      }
      knownSessionIdsRef.current = liveIdSet
      setStoredState({
        ready: true,
        sessionInventory: sessions
          ? inventoryFromSessions(sessions.filter(({ id }) => liveIdSet.has(id)))
          : inventoryFromSessionIds(liveIds),
        sessionsError: false
      })
    },
    [mountedRef]
  )

  const refreshSessionIds = useCallback((): Promise<void> => {
    if (!ready) {
      return Promise.resolve()
    }
    const currentRefresh = sessionIdRefreshRef.current
    if (currentRefresh?.generation === refreshGenerationRef.current) {
      return currentRefresh.promise
    }
    const generation = ++refreshGenerationRef.current
    const lifecycleRevision = lifecycleRevisionRef.current
    const refresh = (async (): Promise<void> => {
      try {
        const sessionIds = await window.api.pty.listSessionIds()
        commitInventory(generation, lifecycleRevision, sessionIds)
      } catch {
        if (mountedRef.current && generation === refreshGenerationRef.current) {
          setStoredState((current) => ({ ...current, sessionsError: true }))
        }
      }
    })().finally(() => {
      if (sessionIdRefreshRef.current?.promise === refresh) {
        sessionIdRefreshRef.current = null
      }
    })
    sessionIdRefreshRef.current = { generation, promise: refresh }
    return refresh
  }, [commitInventory, mountedRef, ready])

  const refreshSessions = useCallback(async (): Promise<void> => {
    if (!ready) {
      return
    }
    const generation = ++refreshGenerationRef.current
    const lifecycleRevision = lifecycleRevisionRef.current
    try {
      const sessions = await window.api.pty.listSessions()
      commitInventory(
        generation,
        lifecycleRevision,
        sessions.map(({ id }) => id),
        sessions
      )
    } catch {
      if (mountedRef.current && generation === refreshGenerationRef.current) {
        setStoredState((current) => ({ ...current, sessionsError: true }))
      }
    }
  }, [commitInventory, mountedRef, ready])

  const clearSessionsError = useCallback((): void => {
    setStoredState((current) => ({ ...current, sessionsError: false }))
  }, [])

  const removeSession = useCallback((sessionId: string): void => {
    // Why: mark the exact PTY removed while a list may be in flight; filtering
    // only that id preserves unrelated sessions discovered by the same list.
    const lifecycleRevision = ++lifecycleRevisionRef.current
    removedAtRevisionRef.current.set(sessionId, lifecycleRevision)
    knownSessionIdsRef.current.delete(sessionId)
    setStoredState((current) => ({
      ...current,
      sessionInventory: removeSessionFromInventory(current.sessionInventory, sessionId)
    }))
  }, [])

  const removeSessions = useCallback((sessionIds: ReadonlySet<string>): void => {
    const lifecycleRevision = ++lifecycleRevisionRef.current
    for (const sessionId of sessionIds) {
      removedAtRevisionRef.current.set(sessionId, lifecycleRevision)
      knownSessionIdsRef.current.delete(sessionId)
    }
    setStoredState((current) => ({
      ...current,
      sessionInventory: removeSessionsFromInventory(current.sessionInventory, sessionIds)
    }))
  }, [])

  useEffect(() => {
    refreshGenerationRef.current += 1
    sessionIdRefreshRef.current = null
    if (!ready) {
      removedAtRevisionRef.current.clear()
      knownSessionIdsRef.current.clear()
      return
    }
    void refreshSessionIds()
  }, [ready, refreshSessionIds])

  useEffect(() => {
    const wasEnabled = previousDetailsEnabledRef.current
    previousDetailsEnabledRef.current = detailsEnabled
    if (ready && wasEnabled && !detailsEnabled) {
      void refreshSessionIds()
    }
  }, [detailsEnabled, ready, refreshSessionIds])

  useEffect(() => {
    if (!ready) {
      return
    }
    let disposed = false
    let refreshTimer: number | null = null
    let lifecycleRefresh: Promise<void> | null = null
    const pendingSpawnIds = new Set<string>()
    const scheduleLifecycleRefresh = (): void => {
      if (disposed || refreshTimer !== null || lifecycleRefresh !== null) {
        return
      }
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null
        if (pendingSpawnIds.size === 0) {
          return
        }
        pendingSpawnIds.clear()
        const refresh = detailsEnabled ? refreshSessions() : refreshSessionIds()
        lifecycleRefresh = refresh
        void refresh.finally(() => {
          if (disposed || lifecycleRefresh !== refresh) {
            return
          }
          lifecycleRefresh = null
          for (const id of pendingSpawnIds) {
            if (knownSessionIdsRef.current.has(id)) {
              pendingSpawnIds.delete(id)
            }
          }
          scheduleLifecycleRefresh()
        })
      }, 0)
    }
    const unsubscribeSpawned = window.api.pty.onSpawned(({ id }) => {
      // Why: reattach emits the same lifecycle signal; known IDs must not turn remounts into global inventory scans.
      if (knownSessionIdsRef.current.has(id)) {
        return
      }
      pendingSpawnIds.add(id)
      // Why: serialize slow provider-wide lists; retry once only when a result missed a later spawn.
      scheduleLifecycleRefresh()
    })
    const unsubscribeExit = window.api.pty.onExit(({ id }) => {
      pendingSpawnIds.delete(id)
      if (pendingSpawnIds.size === 0 && refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
        refreshTimer = null
      }
      removeSession(id)
    })
    return () => {
      disposed = true
      pendingSpawnIds.clear()
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer)
      }
      unsubscribeSpawned()
      unsubscribeExit()
    }
  }, [detailsEnabled, ready, refreshSessionIds, refreshSessions, removeSession])

  return {
    sessionInventory: state.sessionInventory,
    sessionsError: state.sessionsError,
    refreshSessions,
    clearSessionsError,
    removeSession,
    removeSessions
  }
}
