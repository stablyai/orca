import { recoverLoadedAiVaultStructuredTitles } from './ai-vault-structured-title-recovery'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isAiVaultScanCancelledError,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { describeAiVaultScanError } from '../../../../shared/ai-vault-scan-error-message'
import {
  ALL_EXECUTION_HOSTS_SCOPE,
  requestedExecutionHostScope,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'
import { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'
import { EMPTY_AI_VAULT_SESSIONS } from './ai-vault-session-identity'
import { useAppliedAiVaultScan } from './ai-vault-applied-scan'
import {
  aiVaultSessionResultCacheKey,
  applyAiVaultTitleChangesSince,
  cacheAiVaultSessionResult,
  readAiVaultSessionResultSnapshot,
  readCachedAiVaultSessionResult,
  resetAiVaultSessionResultCacheForTest
} from './ai-vault-session-result-cache'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { aiVaultProjectedMetadataEqual } from './ai-vault-structured-title-projection'
import { AiVaultPendingTitleProjection } from './ai-vault-pending-title-projection'
import {
  getAiVaultLiveProviderSessionIdsKey,
  recordAiVaultLiveProviderSessionIds,
  resetAiVaultLiveProviderSessionIdsForTest
} from './ai-vault-live-provider-session-ids'

// In-app session creation bypasses the cache so the new session appears promptly.
// Keep the budget at module scope so tab remounts cannot amplify full scans.
const FORCED_RESCAN_MIN_INTERVAL_MS = 30_000
let lastForcedRescanAt = 0

export function resetAiVaultForcedRescanThrottleForTest(): void {
  lastForcedRescanAt = 0
  resetAiVaultLiveProviderSessionIdsForTest()
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
  sessions: readonly AiVaultSession[]
  /** The depth the sessions on screen came from, which trails the selected one during a rescan. */
  loadedSessionLimit: AiVaultSessionLimit | null
} {
  const { scan, applyScan } = useAppliedAiVaultScan()
  const scanResult = scan?.result ?? null
  const sessions = scanResult?.sessions ?? EMPTY_AI_VAULT_SESSIONS
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestTokenRef = useRef<string>(undefined!)
  requestTokenRef.current ??= createBrowserUuid()
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const pendingForceRef = useRef(false)
  const pendingBackgroundRef = useRef(true)
  const lastAppliedScanRef = useRef<{ scopeKey: string; result: AiVaultListResult } | null>(null)
  const mountedRef = useRef(true)
  const publicationGateRef = useRef<AiVaultSessionPublicationGate>(undefined!)
  const pendingTitlesRef = useRef<AiVaultPendingTitleProjection | null>(null)
  publicationGateRef.current ??= new AiVaultSessionPublicationGate()
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
        lastAppliedScanRef.current = { scopeKey: scanKey, result: cachedResult }
        setError(null)
        publicationGateRef.current.publish(cachedResult, (published) => {
          applyScan(published, selectedLimit, baseKey)
        })
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
      const titleSnapshot = readAiVaultSessionResultSnapshot(baseKey)
      const pendingTitles = new AiVaultPendingTitleProjection(hostScope)
      pendingTitlesRef.current = pendingTitles
      try {
        const response = await window.api.aiVault.listSessions({
          includeAntigravityIdeSessions: true,
          limit,
          unlimited: selectedLimit === 'unlimited',
          scopePaths: scopePathsRef.current,
          executionHostScope: hostScope,
          force: args.force,
          requestToken: requestTokenRef.current
        })
        // A superseded scan resolves cancelled rather than rejecting, so the
        // main-process log stays clean; its empty body must not be painted.
        if (response.cancelled || !mountedRef.current || refreshIdRef.current !== refreshId) {
          return
        }
        // Why: host/scope changes queue a follow-up scan, but the older result
        // may resolve first and must not briefly paint the wrong history list.
        if (scanKey !== currentScanScopeKey()) {
          return
        }
        const result = pendingTitles.apply(
          applyAiVaultTitleChangesSince(response, baseKey, titleSnapshot)
        )
        // A cache hit returns the snapshot already on screen; skip the state
        // updates so refocus flips don't force pointless re-renders.
        // Single-host stamps cover transcript data, but names/ownership are projected afterward.
        // Merged host clocks can repeat despite other changed fields, so reconcile their full body.
        if (
          requestedExecutionHostScope(hostScope) !== ALL_EXECUTION_HOSTS_SCOPE &&
          lastAppliedScanRef.current?.scopeKey === scanKey &&
          lastAppliedScanRef.current.result.scannedAt === result.scannedAt &&
          aiVaultProjectedMetadataEqual(lastAppliedScanRef.current.result, result)
        ) {
          return
        }
        lastAppliedScanRef.current = { scopeKey: scanKey, result }
        cacheAiVaultSessionResult({
          key: baseKey,
          executionHostScope: hostScope,
          limit: selectedLimit,
          result,
          tabs: useAppStore.getState().unifiedTabsByWorktree,
          replaceHostEntries: args.force === true
        })
        if (!titleSnapshot) {
          recoverLoadedAiVaultStructuredTitles(result)
        }
        publicationGateRef.current.publish(result, (published) => {
          if (mountedRef.current && scanKey === currentScanScopeKey()) {
            applyScan(published, selectedLimit, baseKey)
          }
        })
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
          setError(describeAiVaultScanError(err instanceof Error ? err.message : String(err)))
        }
      } finally {
        pendingTitles.stop()
        if (pendingTitlesRef.current === pendingTitles && refreshIdRef.current === refreshId) {
          pendingTitlesRef.current = null
          pendingRefreshRef.current ||= pendingTitles.overflowed
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
      }
      // Deps intentionally avoid changing scope values: refresh reads them
      // through refs and recurses on itself, so its identity must stay stable.
    },
    [applyScan, currentScanScopeKey]
  )

  // Forced rescans triggered by new agent sessions run
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
      requestForcedRescan()
    }, waitMs)
  }, [refresh])

  useEffect(() => {
    mountedRef.current = true
    const requestToken = requestTokenRef.current
    const publicationGate = publicationGateRef.current
    return () => {
      mountedRef.current = false
      publicationGate.cancel()
      pendingTitlesRef.current?.stop()
      pendingTitlesRef.current = null
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

  // Panel entry reuses the renderer result first, then the host scan cache.
  useEffect(() => {
    publicationGateRef.current.cancel()
    if (refreshInFlightRef.current) {
      void window.api.aiVault.cancelListSessions({
        requestToken: requestTokenRef.current
      })
    }
    void refresh({ force: false, reuseLoadedDepth: true })
  }, [executionHostScope, refresh, scanScopeKey])

  // Why: this panel can query the relay before it is ready — at startup, and again for the window
  // in which a reconnect leaves the session not-ready — and the query throws 'SSH relay is not
  // ready'. Nothing else here retries: the remaining triggers are mount, window refocus and a new
  // agent session id, so a user whose workspace is otherwise working sits on that error
  // indefinitely. The file explorer already recovers this way for the same reason
  // (use-file-explorer-tree-load-effects.ts); this panel simply never did.
  //
  // Gated on a prior error so a local workspace, or one that already listed fine, does not rescan
  // every time some other host connects.
  const sshConnectedGeneration = useAppStore((s) => s.sshConnectedGeneration)
  const sshGenerationRef = useRef(sshConnectedGeneration)
  useEffect(() => {
    if (sshConnectedGeneration <= sshGenerationRef.current) {
      return
    }
    sshGenerationRef.current = sshConnectedGeneration
    if (error !== null) {
      void refresh({ background: true, force: false })
    }
  }, [sshConnectedGeneration, error, refresh])

  // Refocus checks the shared host cache without forcing another transcript scan.
  useEffect(() => {
    const onRefocus = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }
      void refresh({ background: true, force: false })
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
  const agentSessionIdsKey = useAppStore((s) =>
    getAiVaultLiveProviderSessionIdsKey(s.agentStatusByPaneKey)
  )
  const seenAgentSessionIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const observed = recordAiVaultLiveProviderSessionIds(
      agentSessionIdsKey,
      seenAgentSessionIdsRef.current
    )
    seenAgentSessionIdsRef.current = observed.seen
    if (observed.added) {
      requestForcedRescan()
    }
  }, [agentSessionIdsKey, requestForcedRescan])

  return { error, loading, refresh, scanResult, sessions, loadedSessionLimit: scan?.limit ?? null }
}
