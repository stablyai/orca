import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { subscribeDaemonSessionInventoryInvalidated } from './daemon-session-inventory-invalidation'
import {
  EMPTY_DAEMON_SESSION_ROWS,
  ResourceSessionInventoryRows,
  type DaemonSessionInventory
} from './resource-session-inventory'
import { readResourceSessionInventory } from './resource-session-inventory-reader'
import { reconcileResourceSessionInventory } from './resource-session-inventory-reconciliation'

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
  sessionCount: number
  sessionRowsRevision: number
  sessionsError: boolean
}

export function useResourceSessionInventory(
  ready: boolean,
  authoritativeInventoryRequested: boolean
): ResourceSessionInventory {
  const mountedRef = useMountedRef()
  const refreshGenerationRef = useRef(0)
  const lifecycleRevisionRef = useRef(0)
  const removedAtRevisionRef = useRef(new Map<string, number>())
  const spawnedAtRevisionRef = useRef(new Map<string, number>())
  const knownSessionIdsRef = useRef(new Set<string>())
  const knownHostIdBySessionIdRef = useRef(new Map<string, ExecutionHostId>())
  const listedSessionIdsRef = useRef(new Set<string>())
  const sessionRowsRef = useRef(new ResourceSessionInventoryRows())
  const previousAuthoritativeInventoryRequestedRef = useRef(authoritativeInventoryRequested)
  const [storedState, setStoredState] = useState<ResourceSessionInventoryState>(() => ({
    ready,
    sessionCount: 0,
    sessionRowsRevision: 0,
    sessionsError: false
  }))
  const state =
    storedState.ready === ready
      ? storedState
      : {
          ready,
          sessionCount: 0,
          sessionRowsRevision: storedState.sessionRowsRevision + 1,
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
      const inventory = await readResourceSessionInventory()
      // Why: lifecycle events can land while the global provider list is in flight.
      // Exits must not resurrect dead sessions, while authoritative novel spawns
      // must remain counted even if this particular list started too early.
      if (!mountedRef.current || generation !== refreshGenerationRef.current) {
        return
      }
      const reconciliation = reconcileResourceSessionInventory({
        snapshot: inventory,
        lifecycleRevision,
        removedAtRevision: removedAtRevisionRef.current,
        spawnedAtRevision: spawnedAtRevisionRef.current,
        currentKnownSessionIds: knownSessionIdsRef.current,
        currentHostIdBySessionId: knownHostIdBySessionIdRef.current
      })
      const { liveSessions, listedSessionIds, knownSessionIds, hostIdBySessionId, complete } =
        reconciliation
      knownSessionIdsRef.current = knownSessionIds
      knownHostIdBySessionIdRef.current = hostIdBySessionId
      listedSessionIdsRef.current = listedSessionIds
      const retainedSessions = sessionRowsRef.current
        .toArray()
        .filter(({ id }) => knownSessionIds.has(id) && !listedSessionIds.has(id))
      const sessions =
        retainedSessions.length === 0 ? liveSessions : [...liveSessions, ...retainedSessions]
      sessionRowsRef.current.replace(sessions)
      setStoredState((current) => ({
        ready: true,
        sessionCount: knownSessionIds.size,
        sessionRowsRevision: current.sessionRowsRevision + 1,
        sessionsError: !complete
      }))
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
    spawnedAtRevisionRef.current.delete(sessionId)
    knownSessionIdsRef.current.delete(sessionId)
    knownHostIdBySessionIdRef.current.delete(sessionId)
    listedSessionIdsRef.current.delete(sessionId)
    const removedRow = sessionRowsRef.current.remove(sessionId)
    setStoredState((current) => ({
      ...current,
      sessionCount: knownSessionIdsRef.current.size,
      sessionRowsRevision: current.sessionRowsRevision + (removedRow ? 1 : 0)
    }))
  }, [])

  const removeSessions = useCallback((sessionIds: ReadonlySet<string>): void => {
    const lifecycleRevision = ++lifecycleRevisionRef.current
    for (const sessionId of sessionIds) {
      removedAtRevisionRef.current.set(sessionId, lifecycleRevision)
      spawnedAtRevisionRef.current.delete(sessionId)
      knownSessionIdsRef.current.delete(sessionId)
      knownHostIdBySessionIdRef.current.delete(sessionId)
      listedSessionIdsRef.current.delete(sessionId)
    }
    const removedRows = sessionRowsRef.current.removeMany(sessionIds)
    setStoredState((current) => ({
      ...current,
      sessionCount: knownSessionIdsRef.current.size,
      sessionRowsRevision: current.sessionRowsRevision + removedRows
    }))
  }, [])

  useEffect(() => {
    refreshGenerationRef.current += 1
    if (!ready) {
      removedAtRevisionRef.current.clear()
      spawnedAtRevisionRef.current.clear()
      knownSessionIdsRef.current.clear()
      knownHostIdBySessionIdRef.current.clear()
      listedSessionIdsRef.current.clear()
      sessionRowsRef.current.clear()
      return
    }
    void refreshSessions()
  }, [ready, refreshSessions])

  useEffect(() => {
    const wasRequested = previousAuthoritativeInventoryRequestedRef.current
    previousAuthoritativeInventoryRequestedRef.current = authoritativeInventoryRequested
    if (ready && authoritativeInventoryRequested && !wasRequested) {
      void refreshSessions()
    }
  }, [authoritativeInventoryRequested, ready, refreshSessions])

  useEffect(() => {
    if (!ready) {
      return
    }
    // Why: management kills/restarts destroy daemon sessions without a pty:exit,
    // so the closed badge would keep the pre-kill count until the popover opens.
    return subscribeDaemonSessionInventoryInvalidated(() => {
      void refreshSessions()
    })
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
            if (listedSessionIdsRef.current.has(id)) {
              pendingSpawnIds.delete(id)
            }
          }
          scheduleLifecycleRefresh()
        })
      }, 0)
    }
    const unsubscribeSpawned = window.api.pty.onSpawned(
      ({ id, hostId, isReattach, exitedBeforeSpawnReply }) => {
        // Why: a spawn already dead before its reply is ambiguous even when
        // its reusable ID is still known; only a full inventory can settle it.
        if (exitedBeforeSpawnReply) {
          pendingSpawnIds.add(id)
          scheduleLifecycleRefresh()
          return
        }
        if (hostId) {
          knownHostIdBySessionIdRef.current.set(id, hostId)
        }
        // Reattach emits the same lifecycle signal. A known ID is already
        // counted; unknown or mixed-version classification must reconcile.
        if (knownSessionIdsRef.current.has(id)) {
          return
        }
        if (isReattach !== false) {
          pendingSpawnIds.add(id)
          scheduleLifecycleRefresh()
          return
        }

        const lifecycleRevision = ++lifecycleRevisionRef.current
        spawnedAtRevisionRef.current.set(id, lifecycleRevision)
        knownSessionIdsRef.current.add(id)
        setStoredState((current) => ({
          ...current,
          sessionCount: knownSessionIdsRef.current.size
        }))

        if (authoritativeInventoryRequested) {
          // The open popover needs full rows, not only the authoritative badge count.
          pendingSpawnIds.add(id)
          scheduleLifecycleRefresh()
        }
      }
    )
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
  }, [authoritativeInventoryRequested, ready, refreshSessions, removeSession])

  const sessions = useMemo(() => {
    // The rows live in a ref; this revision invalidates their materialized snapshot.
    void state.sessionRowsRevision
    return ready && authoritativeInventoryRequested
      ? sessionRowsRef.current.toArray()
      : EMPTY_DAEMON_SESSION_ROWS
  }, [authoritativeInventoryRequested, ready, state.sessionRowsRevision])
  const sessionInventory = useMemo(
    () => ({ sessions, count: state.sessionCount }),
    [sessions, state.sessionCount]
  )
  return {
    sessionInventory,
    sessionsError: state.sessionsError,
    refreshSessions,
    clearSessionsError,
    removeSession,
    removeSessions
  }
}
