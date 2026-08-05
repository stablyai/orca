import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isAiVaultScanCancelledError,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'
import {
  aiVaultSessionResultCacheKey,
  cacheAiVaultSessionResult,
  readCachedAiVaultSessionResult,
  resetAiVaultSessionResultCacheForTest
} from './ai-vault-session-result-cache'

export function resetAiVaultForcedRescanThrottleForTest(): void {
  resetAiVaultSessionResultCacheForTest()
}

// Desktop IPC reports cancellation as a result, but the web/runtime RPC path
// still rejects, so both shapes have to be recognised.
export const isAiVaultScanCancellation = isAiVaultScanCancelledError

type AiVaultRefreshArgs = {
  force?: boolean
  background?: boolean
  reason?: 'manual' | 'passive' | 'session-start'
  refreshExecutionHostId?: ExecutionHostId
  reuseLoadedDepth?: boolean
}

export function useAiVaultSessionRefresh(
  scopePaths: readonly string[],
  executionHostScope: ExecutionHostScope,
  sessionLimit: AiVaultSessionLimit
): {
  error: string | null
  loading: boolean
  refresh: (args?: AiVaultRefreshArgs) => Promise<void>
  scanResult: AiVaultListResult | null
  sessions: AiVaultSession[]
} {
  const [sessions, setSessions] = useState<AiVaultSession[]>([])
  const [scanResult, setScanResult] = useState<AiVaultListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestTokenRef = useRef(crypto.randomUUID())
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const pendingForceRef = useRef(false)
  const pendingBackgroundRef = useRef(true)
  const pendingRefreshHostIdsRef = useRef(new Set<ExecutionHostId>())
  const lastAppliedScanRef = useRef<{ scopeKey: string; scannedAt: string } | null>(null)
  const mountedRef = useRef(true)
  const scanScopeKey = `${aiVaultSessionResultCacheKey(executionHostScope, scopePaths)}\n${sessionLimit}`
  const scopePathsRef = useRef<readonly string[]>(scopePaths)
  scopePathsRef.current = scopePaths
  const executionHostScopeRef = useRef<ExecutionHostScope>(executionHostScope)
  executionHostScopeRef.current = executionHostScope
  const sessionLimitRef = useRef(sessionLimit)
  // Keep render pure for React Doctor; layout effect still lands before refresh effects.
  useLayoutEffect(() => {
    sessionLimitRef.current = sessionLimit
  }, [sessionLimit])
  const currentScanScopeKey = useCallback(
    () =>
      `${aiVaultSessionResultCacheKey(
        executionHostScopeRef.current,
        scopePathsRef.current
      )}\n${sessionLimitRef.current}`,
    []
  )

  const refresh = useCallback(
    async (args: AiVaultRefreshArgs = {}): Promise<void> => {
      const hostScope = executionHostScopeRef.current
      const selectedLimit = sessionLimitRef.current
      const baseKey = aiVaultSessionResultCacheKey(hostScope, scopePathsRef.current)
      const cachedResult =
        args.reuseLoadedDepth === true
          ? readCachedAiVaultSessionResult({
              key: baseKey,
              limit: selectedLimit,
              scopePaths: scopePathsRef.current
            })
          : null
      if (cachedResult) {
        const scanKey = `${baseKey}\n${selectedLimit}`
        lastAppliedScanRef.current = { scopeKey: scanKey, scannedAt: cachedResult.scannedAt }
        setError(null)
        setScanResult(cachedResult)
        setSessions(cachedResult.sessions)
        setLoading(false)
        return
      }
      // A scope change during an in-flight scan must not be dropped; queue one more
      // scan so the current scoped view is refreshed after the older scan settles.
      if (refreshInFlightRef.current) {
        pendingRefreshRef.current = true
        pendingForceRef.current ||= args.force === true || args.reason === 'manual'
        pendingBackgroundRef.current &&= args.background === true
        if (args.reason === 'session-start' && args.refreshExecutionHostId) {
          pendingRefreshHostIdsRef.current.add(args.refreshExecutionHostId)
        }
        return
      }

      refreshInFlightRef.current = true
      const refreshId = refreshIdRef.current + 1
      refreshIdRef.current = refreshId
      // Background (refocus) refreshes usually resolve from the main-process
      // cache; suppressing the loading flag avoids a spinner flash on every
      // return to the app.
      if (args.background !== true) {
        setLoading(true)
      }
      setError(null)
      const limit = selectedLimit === 'unlimited' ? undefined : selectedLimit
      const scanKey = `${baseKey}\n${selectedLimit}`
      try {
        const result = await window.api.aiVault.listSessions({
          limit,
          unlimited: selectedLimit === 'unlimited',
          scopePaths: scopePathsRef.current,
          executionHostScope: hostScope,
          force: args.force ?? false,
          refreshReason: args.reason ?? (args.force ? 'manual' : 'passive'),
          refreshExecutionHostId: args.refreshExecutionHostId,
          requestToken: requestTokenRef.current
        })
        // A superseded scan resolves cancelled rather than rejecting, so the
        // main-process log stays clean; its empty body must not be painted.
        if (result.cancelled || !mountedRef.current || refreshIdRef.current !== refreshId) {
          return
        }
        // Why: host/scope changes queue a follow-up scan, but the older result
        // may resolve first and must not briefly paint the wrong history list.
        if (scanKey !== currentScanScopeKey()) {
          return
        }
        // A cache hit returns the snapshot already on screen; skip the state
        // updates so refocus flips don't force pointless re-renders.
        if (
          lastAppliedScanRef.current?.scopeKey === scanKey &&
          lastAppliedScanRef.current.scannedAt === result.scannedAt
        ) {
          return
        }
        lastAppliedScanRef.current = { scopeKey: scanKey, scannedAt: result.scannedAt }
        cacheAiVaultSessionResult({
          key: baseKey,
          executionHostScope: hostScope,
          limit: selectedLimit,
          result,
          replaceHostEntries: args.force === true || args.reason === 'manual'
        })
        setScanResult(result)
        setSessions(result.sessions)
      } catch (err) {
        // A cancelled scan is not a failure: another caller's forced refresh
        // preempts the shared scan, and painting its abort would replace the
        // list with an error the incoming scan is about to make obsolete.
        if (
          !isAiVaultScanCancellation(err) &&
          mountedRef.current &&
          refreshIdRef.current === refreshId &&
          scanKey === currentScanScopeKey()
        ) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        refreshInFlightRef.current = false
        if (mountedRef.current && refreshIdRef.current === refreshId) {
          setLoading(false)
        }
        if (pendingRefreshRef.current && mountedRef.current) {
          pendingRefreshRef.current = false
          const force = pendingForceRef.current
          // The queued refresh is background-only if every queued caller was.
          const background = pendingBackgroundRef.current
          pendingForceRef.current = false
          pendingBackgroundRef.current = true
          if (force) {
            pendingRefreshHostIdsRef.current.clear()
          }
          const hostIterator = pendingRefreshHostIdsRef.current.values().next()
          const refreshExecutionHostId = hostIterator.done ? undefined : hostIterator.value
          if (refreshExecutionHostId) {
            pendingRefreshHostIdsRef.current.delete(refreshExecutionHostId)
          }
          pendingRefreshRef.current = pendingRefreshHostIdsRef.current.size > 0
          void refresh({
            force,
            background,
            reason: force ? 'manual' : refreshExecutionHostId ? 'session-start' : 'passive',
            refreshExecutionHostId
          })
        }
      }
      // Deps intentionally avoid changing scope values: refresh reads them
      // through refs and recurses on itself, so its identity must stay stable.
    },
    [currentScanScopeKey]
  )

  useEffect(() => {
    mountedRef.current = true
    const requestToken = requestTokenRef.current
    return () => {
      mountedRef.current = false
      refreshIdRef.current += 1
      refreshInFlightRef.current = false
      void window.api.aiVault.cancelListSessions({
        requestToken
      })
    }
  }, [])

  // Reuse loaded renderer depth on entry; otherwise apply the host-aware passive policy.
  useEffect(() => {
    if (refreshInFlightRef.current) {
      void window.api.aiVault.cancelListSessions({
        requestToken: requestTokenRef.current
      })
    }
    void refresh({ reason: 'passive', reuseLoadedDepth: true })
  }, [executionHostScope, refresh, scanScopeKey])

  // Main-process focus covers macOS activation; visibility covers restore.
  useEffect(() => {
    const onRefocus = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }
      void refresh({ background: true, reason: 'passive' })
    }
    const unsubscribeWindowFocus = window.api.aiVault.onWindowFocused?.(onRefocus)
    document.addEventListener('visibilitychange', onRefocus)
    return () => {
      unsubscribeWindowFocus?.()
      document.removeEventListener('visibilitychange', onRefocus)
    }
  }, [refresh])

  // Sessions started inside Orca never blur the window, so refocus alone
  // can't surface them. Agent hooks already report provider sessions; re-scan
  // only when a session id we haven't seen appears — state transitions are
  // deliberately ignored, they fire constantly while agents work.
  const agentSessionIdsKey = useAppStore((state) => {
    const ids: [ExecutionHostId, string][] = []
    for (const entry of Object.values(state.agentStatusByPaneKey)) {
      if (entry.providerSession?.id) {
        const hostId = entry.connectionId
          ? toSshExecutionHostId(entry.connectionId)
          : entry.worktreeId
            ? getExecutionHostIdForWorktree(state, entry.worktreeId)
            : LOCAL_EXECUTION_HOST_ID
        ids.push([hostId, entry.providerSession.id])
      }
    }
    return JSON.stringify(
      ids.sort((left, right) => left.join('\0').localeCompare(right.join('\0')))
    )
  })
  const seenAgentSessionIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const entries = JSON.parse(agentSessionIdsKey) as [ExecutionHostId, string][]
    const ids = entries.map(([hostId, sessionId]) => `${hostId}\0${sessionId}`)
    // The mount refresh already covers sessions live at mount time.
    if (seenAgentSessionIdsRef.current === null) {
      seenAgentSessionIdsRef.current = new Set(ids)
      return
    }
    const seen = seenAgentSessionIdsRef.current
    const freshEntries = entries.filter(
      ([hostId, sessionId]) => !seen.has(`${hostId}\0${sessionId}`)
    )
    if (freshEntries.length === 0) {
      return
    }
    for (const [hostId, sessionId] of freshEntries) {
      seen.add(`${hostId}\0${sessionId}`)
      const selectedHost = executionHostScopeRef.current
      if (selectedHost !== 'all' && selectedHost !== hostId) {
        continue
      }
      void refresh({
        background: true,
        reason: 'session-start',
        refreshExecutionHostId: hostId
      })
    }
  }, [agentSessionIdsKey, refresh])

  return { error, loading, refresh, scanResult, sessions }
}
