import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isAiVaultScanCancelledError,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostScope } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'
import {
  aiVaultSessionResultCacheKey,
  cacheAiVaultSessionResult,
  readCachedAiVaultSessionResult,
  resetAiVaultSessionResultCacheForTest
} from './ai-vault-session-result-cache'

// Panel entry and window refocus must show sessions started since the last
// scan, so they bypass the main process's 15s cache — but a full scan parses
// up to ~1000 transcripts, so bound forced scans to one per interval. Module
// scope so the throttle survives panel remounts (the panel unmounts per tab).
const FORCED_RESCAN_MIN_INTERVAL_MS = 5_000
let lastForcedRescanAt = 0

function consumeForcedRescanBudget(): boolean {
  const now = Date.now()
  if (now - lastForcedRescanAt < FORCED_RESCAN_MIN_INTERVAL_MS) {
    return false
  }
  lastForcedRescanAt = now
  return true
}

export function resetAiVaultForcedRescanThrottleForTest(): void {
  lastForcedRescanAt = 0
  resetAiVaultSessionResultCacheForTest()
}

// Desktop IPC reports cancellation as a result, but the web/runtime RPC path
// still rejects, so both shapes have to be recognised.
export const isAiVaultScanCancellation = isAiVaultScanCancelledError

type AiVaultRefreshArgs = { force?: boolean; background?: boolean; reuseLoadedDepth?: boolean }

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
        pendingForceRef.current ||= args.force === true
        pendingBackgroundRef.current &&= args.background === true
        return
      }

      refreshInFlightRef.current = true
      const refreshId = refreshIdRef.current + 1
      refreshIdRef.current = refreshId
      // A manual force scan counts against the throttle so an auto rescan right
      // after the button press doesn't trigger a second full scan.
      if (args.force === true) {
        lastForcedRescanAt = Date.now()
      }
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
          force: args.force,
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
          replaceHostEntries: args.force === true
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
          void refresh({ force, background })
        }
      }
      // Deps intentionally avoid changing scope values: refresh reads them
      // through refs and recurses on itself, so its identity must stay stable.
    },
    [currentScanScopeKey]
  )

  // Forced rescans triggered by events (refocus, agent-session starts) run
  // immediately when the throttle allows, otherwise once as soon as it frees
  // up — dropping the event would leave a just-started session invisible
  // until some unrelated later trigger.
  const forcedRescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestForcedRescan = useCallback(() => {
    const waitMs = lastForcedRescanAt + FORCED_RESCAN_MIN_INTERVAL_MS - Date.now()
    if (waitMs <= 0) {
      lastForcedRescanAt = Date.now()
      void refresh({ background: true, force: true })
      return
    }
    if (forcedRescanTimerRef.current !== null) {
      return
    }
    forcedRescanTimerRef.current = setTimeout(() => {
      forcedRescanTimerRef.current = null
      lastForcedRescanAt = Date.now()
      void refresh({ background: true, force: true })
    }, waitMs)
  }, [refresh])

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
      if (forcedRescanTimerRef.current !== null) {
        clearTimeout(forcedRescanTimerRef.current)
        forcedRescanTimerRef.current = null
      }
    }
  }, [])

  // Remote scans can take long enough for normal tab navigation to feel stuck,
  // so re-entering a remote panel uses its host/scope cache. Explicit refresh,
  // app refocus and new in-app agent sessions still force a fresh scan.
  useEffect(() => {
    if (refreshInFlightRef.current) {
      void window.api.aiVault.cancelListSessions({
        requestToken: requestTokenRef.current
      })
    }
    const refreshOnEntry = executionHostScope === LOCAL_EXECUTION_HOST_ID
    const force = refreshOnEntry && consumeForcedRescanBudget()
    void refresh({ force, reuseLoadedDepth: true })
    if (refreshOnEntry && !force) {
      requestForcedRescan()
    }
  }, [executionHostScope, refresh, requestForcedRescan, scanScopeKey])

  // Sessions started while the app was backgrounded should appear when the
  // user returns, so refocus also bypasses the scan cache (throttled). OS
  // refocus arrives via the main process — renderer DOM focus events don't
  // fire on macOS app activation; visibilitychange covers minimize-restore.
  useEffect(() => {
    const onRefocus = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }
      requestForcedRescan()
    }
    const unsubscribeWindowFocus = window.api.aiVault.onWindowFocused?.(onRefocus)
    document.addEventListener('visibilitychange', onRefocus)
    return () => {
      unsubscribeWindowFocus?.()
      document.removeEventListener('visibilitychange', onRefocus)
    }
  }, [requestForcedRescan])

  // Sessions started inside Orca never blur the window, so refocus alone
  // can't surface them. Agent hooks already report provider sessions; re-scan
  // only when a session id we haven't seen appears — state transitions are
  // deliberately ignored, they fire constantly while agents work.
  const agentSessionIdsKey = useAppStore((s) => {
    const ids: string[] = []
    for (const entry of Object.values(s.agentStatusByPaneKey)) {
      if (entry.providerSession?.id) {
        ids.push(entry.providerSession.id)
      }
    }
    return ids.sort().join('\n')
  })
  const seenAgentSessionIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = agentSessionIdsKey === '' ? [] : agentSessionIdsKey.split('\n')
    // The mount refresh already covers sessions live at mount time.
    if (seenAgentSessionIdsRef.current === null) {
      seenAgentSessionIdsRef.current = new Set(ids)
      return
    }
    const seen = seenAgentSessionIdsRef.current
    const freshIds = ids.filter((id) => !seen.has(id))
    if (freshIds.length === 0) {
      return
    }
    for (const id of freshIds) {
      seen.add(id)
    }
    requestForcedRescan()
  }, [agentSessionIdsKey, requestForcedRescan])

  return { error, loading, refresh, scanResult, sessions }
}
