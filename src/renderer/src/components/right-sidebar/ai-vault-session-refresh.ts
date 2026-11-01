import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  isAiVaultScanCancelledError,
  type AiVaultListResult,
  type AiVaultSession
} from '../../../../shared/ai-vault-types'
import { aiVaultScanErrorText } from './ai-vault-scan-issue-copy'
import type { ExecutionHostScope } from '../../../../shared/execution-host'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'
import { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'
import { EMPTY_AI_VAULT_SESSIONS } from './ai-vault-session-identity'
import { useAppliedAiVaultScan } from './ai-vault-applied-scan'
import { useAiVaultSessionHostRefreshEvents } from './ai-vault-host-scope'
import {
  aiVaultSessionResultCacheKey,
  resetAiVaultSessionResultCacheForTest
} from './ai-vault-session-result-cache'
import {
  refreshAiVaultSessionList,
  type AiVaultConditionalSnapshot,
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList
} from './ai-vault-session-list-request'
import { resetAgentSessionIdsRefreshKeys } from './ai-vault-agent-session-refresh-key'
import { useAiVaultAssociationObservation } from './ai-vault-association-observation'
import { createBrowserUuid } from '@/lib/browser-uuid'
import {
  useAiVaultConversationRefresh,
  useAiVaultProviderSessionRefresh
} from './ai-vault-conversation-refresh'

// Share the forced-rescan budget across remounts so session creation cannot amplify full scans.
import {
  claimAiVaultForcedRescan,
  aiVaultForcedRescanDelay,
  resetAiVaultForcedRescanBudgetForTest
} from './ai-vault-forced-rescan-budget'
export { claimAiVaultForcedRescan } from './ai-vault-forced-rescan-budget'

export function resetAiVaultForcedRescanThrottleForTest(): void {
  resetAiVaultForcedRescanBudgetForTest()
  resetAgentSessionIdsRefreshKeys()
  resetAiVaultSessionResultCacheForTest()
}

// Desktop IPC resolves cancellations; web/runtime RPC rejects, so recognize both.
export const isAiVaultScanCancellation = isAiVaultScanCancelledError

type AiVaultRefreshArgs = { force?: boolean; background?: boolean; reuseLoadedDepth?: boolean }

export function useAiVaultSessionRefresh(
  scopePaths: readonly string[],
  executionHostScope: ExecutionHostScope,
  sessionLimit: AiVaultSessionLimit,
  includeStructuredSessions = false
): {
  error: string | null
  loading: boolean
  scopePending: boolean
  refresh: (args?: AiVaultRefreshArgs) => Promise<void>
  scanResult: AiVaultListResult | null
  sessions: readonly AiVaultSession[]
  /** The depth the sessions on screen came from, which trails the selected one during a rescan. */
  loadedSessionLimit: AiVaultSessionLimit | null
} {
  const { scan, applyScan } = useAppliedAiVaultScan()
  const associations = useAiVaultAssociationObservation(executionHostScope)
  const associationsRef = useRef(associations)
  const scanScopeKey = `${aiVaultSessionResultCacheKey(executionHostScope, scopePaths, includeStructuredSessions)}\n${sessionLimit}`
  const visibleScan = includeStructuredSessions && scan?.scopeKey !== scanScopeKey ? null : scan
  const scanResult = visibleScan?.result ?? null
  const sessions = scanResult?.sessions ?? EMPTY_AI_VAULT_SESSIONS
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{ scopeKey: string; cause: string } | null>(null)
  const [terminalScopeKey, setTerminalScopeKey] = useState<string | null>(null)
  const requestTokenRef = useRef<string>(undefined!)
  requestTokenRef.current ??= createBrowserUuid()
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const pendingForceRef = useRef(false)
  const pendingBackgroundRef = useRef(true)
  const conditionalSnapshotRef = useRef<(AiVaultConditionalSnapshot & { scopeKey: string }) | null>(
    null
  )
  const mountedRef = useRef(true)
  const publicationGateRef = useRef<AiVaultSessionPublicationGate>(undefined!)
  publicationGateRef.current ??= new AiVaultSessionPublicationGate()
  const includeStructuredSessionsRef = useRef(includeStructuredSessions)
  includeStructuredSessionsRef.current = includeStructuredSessions
  // Kept through rescans so a repeat failure doesn't blink; shown only for the scope that failed.
  const error = failure?.scopeKey === scanScopeKey ? aiVaultScanErrorText(failure.cause) : null
  const scopePathsRef = useRef<readonly string[]>(scopePaths)
  scopePathsRef.current = scopePaths
  const executionHostScopeRef = useRef<ExecutionHostScope>(executionHostScope)
  executionHostScopeRef.current = executionHostScope
  const sessionLimitRef = useRef(sessionLimit)
  // Keep render pure for React Doctor; layout effect still lands before refresh effects.
  useLayoutEffect(() => {
    sessionLimitRef.current = sessionLimit
    associationsRef.current = associations
  }, [associations, sessionLimit])
  const currentScanScopeKey = useCallback(
    () =>
      `${aiVaultSessionResultCacheKey(
        executionHostScopeRef.current,
        scopePathsRef.current,
        includeStructuredSessionsRef.current
      )}\n${sessionLimitRef.current}`,
    []
  )
  const refresh = useCallback(
    async (args: AiVaultRefreshArgs = {}): Promise<void> => {
      const observation = associationsRef.current
      const associationRevision = observation.getSnapshot()
      const associationCurrent = () =>
        observation === associationsRef.current && associationRevision === observation.getSnapshot()
      const hostScope = executionHostScopeRef.current
      const selectedLimit = sessionLimitRef.current
      const baseKey = aiVaultSessionResultCacheKey(
        hostScope,
        scopePathsRef.current,
        includeStructuredSessionsRef.current
      )
      const cachedResult =
        args.reuseLoadedDepth === true
          ? readCachedAiVaultSessionList({
              scopePaths: scopePathsRef.current,
              includeStructuredSessions: includeStructuredSessionsRef.current,
              executionHostScope: hostScope,
              sessionLimit: selectedLimit
            })
          : null
      if (cachedResult) {
        const scanKey = `${baseKey}\n${selectedLimit}`
        setFailure(null)
        setTerminalScopeKey(null)
        publicationGateRef.current.publish(cachedResult, (published) => {
          if (!mountedRef.current || scanKey !== currentScanScopeKey() || !associationCurrent()) {
            return
          }
          applyScan(published, selectedLimit, scanKey, (applied) => {
            conditionalSnapshotRef.current = published.fingerprint
              ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
              : null
          })
        })
        setLoading(false)
      }
      // Queue scope changes during an in-flight scan so the new view still refreshes.
      if (refreshInFlightRef.current) {
        pendingRefreshRef.current = true
        pendingForceRef.current ||= args.force === true
        pendingBackgroundRef.current &&= args.background === true || cachedResult !== null
        if (args.force === true && args.background !== true) {
          void window.api.aiVault
            .cancelListSessions({ requestToken: requestTokenRef.current })
            .catch((error: unknown) => console.warn('Could not cancel Session History scan', error))
        }
        return
      }

      refreshInFlightRef.current = true
      const refreshId = refreshIdRef.current + 1
      refreshIdRef.current = refreshId
      // Count manual refresh against the throttle to prevent an immediate automatic full scan.
      if (args.force === true) {
        claimAiVaultForcedRescan(true)
      }
      // Background cache hits must not flash a loading spinner on every refocus.
      if (args.background !== true && !cachedResult) {
        setLoading(true)
      }
      setTerminalScopeKey(null)
      const scanKey = `${baseKey}\n${selectedLimit}`
      const requestCurrent = () =>
        mountedRef.current &&
        refreshIdRef.current === refreshId &&
        scanKey === currentScanScopeKey() &&
        associationCurrent()
      const request = {
        ...(includeStructuredSessionsRef.current ? { includeStructuredSessions: true } : {}),
        scopePaths: scopePathsRef.current,
        executionHostScope: hostScope,
        sessionLimit: selectedLimit
      }
      try {
        const previous = conditionalSnapshotRef.current
        const result = await refreshAiVaultSessionList(
          request,
          { force: args.force, requestToken: requestTokenRef.current },
          previous?.scopeKey === scanKey ? previous : undefined
        )
        // Reject superseded or old-scope replies before they can repaint History.
        if (!requestCurrent()) {
          return
        }
        if (result.cancelled) {
          setTerminalScopeKey(scanKey)
          return
        }
        setFailure(null)
        cacheAiVaultSessionList(request, result, { replaceHostEntries: args.force === true })
        publicationGateRef.current.publish(result, (published) => {
          if (requestCurrent()) {
            applyScan(published, selectedLimit, scanKey, (applied) => {
              conditionalSnapshotRef.current = published.fingerprint
                ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
                : null
            })
          }
        })
      } catch (err) {
        // Cancellation means another shared scan superseded this one; do not replace its incoming list with an error.
        if (requestCurrent()) {
          setTerminalScopeKey(scanKey)
          if (!isAiVaultScanCancellation(err)) {
            setFailure({
              scopeKey: scanKey,
              cause: err instanceof Error ? err.message : String(err)
            })
          }
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
      // Read changing scope through refs; recursion requires a stable refresh identity.
    },
    [applyScan, currentScanScopeKey]
  )

  // Defer throttled new-session rescans until budget frees so sessions cannot remain invisible indefinitely.
  const forcedRescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestForcedRescan = useCallback(() => {
    if (claimAiVaultForcedRescan()) {
      void refresh({ background: true, force: true })
      return
    }
    const waitMs = aiVaultForcedRescanDelay()
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
      pendingRefreshRef.current = false
      pendingForceRef.current = false
      pendingBackgroundRef.current = true
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
    pendingRefreshRef.current = false
    pendingForceRef.current = false
    pendingBackgroundRef.current = true
    if (refreshInFlightRef.current) {
      void window.api.aiVault.cancelListSessions({
        requestToken: requestTokenRef.current
      })
    }
    void refresh({ force: false, reuseLoadedDepth: true })
  }, [associations, executionHostScope, refresh, scanScopeKey])

  useEffect(
    () =>
      associations.subscribe(() => {
        publicationGateRef.current.cancel()
        conditionalSnapshotRef.current = null
        void refresh({ background: true, force: false })
      }),
    [associations, refresh]
  )

  // Retry prior relay-readiness errors on host events; otherwise startup/reconnect failures can persist indefinitely.
  useAiVaultSessionHostRefreshEvents(error, refresh)
  useAiVaultConversationRefresh(includeStructuredSessions, executionHostScope, refresh)

  useAiVaultProviderSessionRefresh(includeStructuredSessions, requestForcedRescan)

  const scopePending = scan?.scopeKey !== scanScopeKey && terminalScopeKey !== scanScopeKey
  return {
    error,
    loading: loading || scopePending,
    scopePending,
    refresh,
    scanResult,
    sessions,
    loadedSessionLimit: visibleScan?.limit ?? null
  }
}
