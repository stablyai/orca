import { useCallback, useEffect, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  EMPTY_DAEMON_SESSION_INVENTORY,
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

export function useResourceSessionInventory(ready: boolean): ResourceSessionInventory {
  const mountedRef = useMountedRef()
  const refreshGenerationRef = useRef(0)
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

  const refreshSessions = useCallback(async (): Promise<void> => {
    if (!ready) {
      return
    }
    const generation = ++refreshGenerationRef.current
    const lifecycleRevision = lifecycleRevisionRef.current
    try {
      const sessions = await window.api.pty.listSessions()
      // Why: an exit or newer refresh can land while the global provider list
      // is in flight; stale results must not resurrect dead sessions.
      if (!mountedRef.current || generation !== refreshGenerationRef.current) {
        return
      }
      const currentRemovedAtRevision = removedAtRevisionRef.current
      const liveSessions = sessions.filter(
        ({ id }) => (currentRemovedAtRevision.get(id) ?? 0) <= lifecycleRevision
      )
      // Tombstones at or before this request cannot suppress later ID reuse;
      // only exits that raced this request must survive to the next refresh.
      for (const [id, removedAtRevision] of currentRemovedAtRevision) {
        if (removedAtRevision <= lifecycleRevision) {
          currentRemovedAtRevision.delete(id)
        }
      }
      knownSessionIdsRef.current = new Set(liveSessions.map(({ id }) => id))
      setStoredState({
        ready: true,
        sessionInventory: inventoryFromSessions(liveSessions),
        sessionsError: false
      })
    } catch {
      if (mountedRef.current && generation === refreshGenerationRef.current) {
        setStoredState((current) => ({ ...current, sessionsError: true }))
      }
    }
  }, [mountedRef, ready])

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
    if (!ready) {
      removedAtRevisionRef.current.clear()
      knownSessionIdsRef.current.clear()
      return
    }
    void refreshSessions()
  }, [ready, refreshSessions])

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
        const refresh = refreshSessions()
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
  }, [ready, refreshSessions, removeSession])

  return {
    sessionInventory: state.sessionInventory,
    sessionsError: state.sessionsError,
    refreshSessions,
    clearSessionsError,
    removeSession,
    removeSessions
  }
}
