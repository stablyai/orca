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
import {
  getAgentSessionIdsKey,
  resetAgentSessionIdsRefreshKeys
} from './ai-vault-agent-session-refresh-key'
import { createBrowserUuid } from '@/lib/browser-uuid'

// Share the forced-rescan budget across remounts so session creation cannot amplify full scans.
const FORCED_RESCAN_MIN_INTERVAL_MS = 30_000
let lastForcedRescanAt = 0

/** All forced callers share this budget; explicit requests consume it even when spent to suppress automatic follow-ups. */
export function claimAiVaultForcedRescan(userRequested = false): boolean {
  const now = Date.now()
  if (!userRequested && lastForcedRescanAt + FORCED_RESCAN_MIN_INTERVAL_MS > now) {
    return false
  }
  lastForcedRescanAt = now
  return true
}

export function resetAiVaultForcedRescanThrottleForTest(): void {
  lastForcedRescanAt = 0
  resetAgentSessionIdsRefreshKeys()
  resetAiVaultSessionResultCacheForTest()
}

// Desktop IPC resolves cancellations; web/runtime RPC rejects, so recognize both.
export const isAiVaultScanCancellation = isAiVaultScanCancelledError

type AiVaultRefreshArgs = { force?: boolean; background?: boolean; reuseLoadedDepth?: boolean }

// Use desktop merge semantics even if web drops scope: redundant reconciliation is safer than trusting a merged stamp.
function isMergedAiVaultHostScope(scope: ExecutionHostScope): boolean {
  return requestedExecutionHostScope(scope) === ALL_EXECUTION_HOSTS_SCOPE
}

export function useAiVaultSessionRefresh(
  scopePaths: readonly string[],
  executionHostScope: ExecutionHostScope,
  sessionLimit: AiVaultSessionLimit
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
  const scanResult = scan?.result ?? null
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
  const lastAppliedScanRef = useRef<{ scopeKey: string; scannedAt: string } | null>(null)
  const conditionalSnapshotRef = useRef<(AiVaultConditionalSnapshot & { scopeKey: string }) | null>(
    null
  )
  const mountedRef = useRef(true)
  const publicationGateRef = useRef<AiVaultSessionPublicationGate>(undefined!)
  publicationGateRef.current ??= new AiVaultSessionPublicationGate()
  const scanScopeKey = `${aiVaultSessionResultCacheKey(executionHostScope, scopePaths)}\n${sessionLimit}`
  // Kept through rescans so a repeat failure doesn't blink; shown only for the scope that failed.
  const error = failure?.scopeKey === scanScopeKey ? describeAiVaultScanError(failure.cause) : null
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
          ? readCachedAiVaultSessionList({
              scopePaths: scopePathsRef.current,
              executionHostScope: hostScope,
              sessionLimit: selectedLimit
            })
          : null
      if (cachedResult) {
        const scanKey = `${baseKey}\n${selectedLimit}`
        lastAppliedScanRef.current = { scopeKey: scanKey, scannedAt: cachedResult.scannedAt }
        setFailure(null)
        setTerminalScopeKey(null)
        publicationGateRef.current.publish(cachedResult, (published) => {
          applyScan(published, selectedLimit, scanKey, (applied) => {
            conditionalSnapshotRef.current = published.fingerprint
              ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
              : null
          })
        })
        setLoading(false)
        return
      }
      // Queue scope changes during an in-flight scan so the new view still refreshes.
      if (refreshInFlightRef.current) {
        pendingRefreshRef.current = true
        pendingForceRef.current ||= args.force === true
        pendingBackgroundRef.current &&= args.background === true
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
        lastForcedRescanAt = Date.now()
      }
      // Background cache hits must not flash a loading spinner on every refocus.
      if (args.background !== true) {
        setLoading(true)
      }
      setTerminalScopeKey(null)
      const scanKey = `${baseKey}\n${selectedLimit}`
      const request = {
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
        // Superseded scans resolve cancelled to keep main logs clean; never paint their empty results.
        if (!mountedRef.current || refreshIdRef.current !== refreshId) {
          return
        }
        // Reject old-scope results before the queued scan so the wrong history never flashes.
        if (scanKey !== currentScanScopeKey()) {
          return
        }
        if (result.cancelled) {
          setTerminalScopeKey(scanKey)
          return
        }
        setFailure(null)
        // Equal single-host stamps skip replayed snapshots; merged stamps can hide lagging-host changes and require structural comparison.
        if (
          !isMergedAiVaultHostScope(hostScope) &&
          lastAppliedScanRef.current?.scopeKey === scanKey &&
          lastAppliedScanRef.current.scannedAt === result.scannedAt &&
          result.fingerprint === undefined
        ) {
          return
        }
        lastAppliedScanRef.current = { scopeKey: scanKey, scannedAt: result.scannedAt }
        cacheAiVaultSessionList(request, result, { replaceHostEntries: args.force === true })
        publicationGateRef.current.publish(result, (published) => {
          if (mountedRef.current && scanKey === currentScanScopeKey()) {
            applyScan(published, selectedLimit, scanKey, (applied) => {
              conditionalSnapshotRef.current = published.fingerprint
                ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
                : null
            })
          }
        })
      } catch (err) {
        // Cancellation means another shared scan superseded this one; do not replace its incoming list with an error.
        if (
          mountedRef.current &&
          refreshIdRef.current === refreshId &&
          scanKey === currentScanScopeKey()
        ) {
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
    const waitMs = lastForcedRescanAt + FORCED_RESCAN_MIN_INTERVAL_MS - Date.now()
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

  // Retry prior relay-readiness errors on host events; otherwise startup/reconnect failures can persist indefinitely.
  useAiVaultSessionHostRefreshEvents(error, refresh)

  // In-app launches never blur; rescan on new provider session IDs, avoiding frequent state transitions.
  const agentSessionIdsKey = useAppStore((s) => getAgentSessionIdsKey(s.agentStatusByPaneKey))
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

  const scopePending = scan?.scopeKey !== scanScopeKey && terminalScopeKey !== scanScopeKey
  return {
    error,
    loading: loading || scopePending,
    scopePending,
    refresh,
    scanResult,
    sessions,
    loadedSessionLimit: scan?.limit ?? null
  }
}
