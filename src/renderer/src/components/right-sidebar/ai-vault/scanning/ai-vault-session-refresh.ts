import { observeAiVaultProvisionalRows } from '../../ai-vault-provisional-rows'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { aiVaultScanErrorText } from './ai-vault-scan-issue-copy'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'
import { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'
import { EMPTY_AI_VAULT_SESSIONS } from '../session-list/ai-vault-session-identity'
import { useAppliedAiVaultScan } from './ai-vault-applied-scan'
import { useAiVaultSessionHostRefreshEvents } from '../scope/ai-vault-host-scope'
import {
  aiVaultSessionResultCacheKey,
  resetAiVaultSessionResultCacheForTest
} from './ai-vault-session-result-cache'
import {
  refreshAiVaultSessionList,
  type AiVaultConditionalSnapshot,
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList,
  readLastAiVaultSessionList
} from './ai-vault-session-list-request'
import { resetAgentSessionIdsRefreshKeys } from './ai-vault-agent-session-refresh-key'
import { useAiVaultNewSessionRescan } from './ai-vault-new-session-rescan'
import { saveAiVaultSessionList } from './ai-vault-saved-session-lists'
import { useAiVaultAssociationObservation } from './ai-vault-association-observation'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import {
  claimAiVaultForcedRescan,
  resetAiVaultForcedRescanBudgetForTest
} from './ai-vault-forced-rescan-budget'
import {
  type AiVaultListResult,
  type AiVaultSession,
  isAiVaultScanCancelledError as isAiVaultScanCancellation
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

export function resetAiVaultForcedRescanThrottleForTest(): void {
  resetAiVaultForcedRescanBudgetForTest()
  resetAgentSessionIdsRefreshKeys()
  resetAiVaultSessionResultCacheForTest()
}

// Desktop IPC resolves cancellations; web/runtime RPC rejects, so recognize both.

type AiVaultRefreshArgs = { force?: boolean; background?: boolean; reuseLoadedDepth?: boolean }

export function useAiVaultSessionRefresh(
  scopePaths: readonly string[],
  executionHostScope: ExecutionHostScope,
  sessionLimit: AiVaultSessionLimit,
  scopeOnly = false
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
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{ scopeKey: string; cause: string } | null>(null)
  const [terminalScopeKey, setTerminalScopeKey] = useState<string | null>(null)
  const requestTokensRef = useRef(new Set<string>())
  const appliedScanRef = useRef(scan)
  appliedScanRef.current = scan
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
  const scanScopeKey = `${aiVaultSessionResultCacheKey(executionHostScope, scopePaths, scopeOnly)}\n${sessionLimit}`
  // Workspace or Project rows would pass for All's list while it loads or after it fails; the filter narrows the rest.
  const shown = scan?.scopeOnly && !scopeOnly ? null : scan
  // Kept through rescans so a repeat failure doesn't blink; shown only for the scope that failed.
  const error = failure?.scopeKey === scanScopeKey ? aiVaultScanErrorText(failure.cause) : null
  const scopePathsRef = useRef<readonly string[]>(scopePaths)
  scopePathsRef.current = scopePaths
  const scopeOnlyRef = useRef(scopeOnly)
  const executionHostScopeRef = useRef<ExecutionHostScope>(executionHostScope)
  executionHostScopeRef.current = executionHostScope
  const sessionLimitRef = useRef(sessionLimit)
  // Keep render pure for React Doctor; layout effect still lands before refresh effects.
  useLayoutEffect(() => {
    sessionLimitRef.current = sessionLimit
    scopeOnlyRef.current = scopeOnly
    associationsRef.current = associations
  }, [associations, scopeOnly, sessionLimit])
  const currentScanScopeKey = useCallback(
    () =>
      `${aiVaultSessionResultCacheKey(
        executionHostScopeRef.current,
        scopePathsRef.current,
        scopeOnlyRef.current
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
      const request = {
        scopePaths: scopePathsRef.current,
        scopeOnly: scopeOnlyRef.current,
        executionHostScope: hostScope,
        sessionLimit: selectedLimit
      }
      const { scopeOnly } = request
      const baseKey = aiVaultSessionResultCacheKey(hostScope, request.scopePaths, scopeOnly)
      const scanKey = `${baseKey}\n${selectedLimit}`
      const applyListed = (published: AiVaultListResult, scanned = false) =>
        applyScan(
          { result: published, limit: selectedLimit, scopeKey: scanKey, scopeOnly },
          (applied) => {
            conditionalSnapshotRef.current = published.fingerprint
              ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
              : null
            // The applied rows keep their identity when a rescan changed nothing, so the save skips.
            if (scanned) {
              void saveAiVaultSessionList(baseKey, selectedLimit, applied)
            }
          }
        )
      const cachedResult =
        args.reuseLoadedDepth === true ? readCachedAiVaultSessionList(request) : null
      if (cachedResult) {
        setFailure(null)
        setTerminalScopeKey(null)
        publicationGateRef.current.publish(cachedResult, (published) => {
          if (mountedRef.current && scanKey === currentScanScopeKey() && associationCurrent()) {
            applyListed(published)
          }
        })
        setLoading(false)
      } else if (args.reuseLoadedDepth === true) {
        publicationGateRef.current.showUntilPublished(
          readLastAiVaultSessionList(request),
          // Chat links only change which rows are linked; the stale list is replaced by the rescan anyway.
          ({ result, limit }) => {
            if (mountedRef.current && scanKey === currentScanScopeKey()) {
              applyScan({ result, limit, scopeKey: scanKey, scopeOnly, stale: true })
            }
          }
        )
      }
      // Queue scope changes during an in-flight scan so the new view still refreshes.
      if (refreshInFlightRef.current && !(args.force === true && args.background !== true)) {
        pendingRefreshRef.current = true
        pendingForceRef.current ||= args.force === true
        pendingBackgroundRef.current &&= args.background === true || cachedResult !== null
        return
      }

      const requestToken = createBrowserUuid()
      requestTokensRef.current.add(requestToken)
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
      const requestCurrent = () =>
        mountedRef.current &&
        refreshIdRef.current === refreshId &&
        scanKey === currentScanScopeKey() &&
        associationCurrent()
      const stopRows = observeAiVaultProvisionalRows({
        requestToken,
        baseline:
          appliedScanRef.current?.scopeKey === scanKey
            ? appliedScanRef.current.result.sessions
            : [],
        deleted: new Set(),
        gate: publicationGateRef.current,
        isCurrent: requestCurrent,
        limit: selectedLimit === 'unlimited' ? Infinity : selectedLimit,
        apply: (sessions) =>
          applyScan({
            result: { sessions: [...sessions], issues: [], scannedAt: new Date().toISOString() },
            limit: selectedLimit,
            scopeKey: scanKey,
            scopeOnly,
            stale: true
          })
      })
      try {
        const previous = conditionalSnapshotRef.current
        const result = await refreshAiVaultSessionList(
          request,
          { force: args.force, requestToken },
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
            applyListed(published, true)
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
        stopRows()
        requestTokensRef.current.delete(requestToken)
        refreshInFlightRef.current = requestTokensRef.current.size > 0
        if (mountedRef.current && refreshIdRef.current === refreshId) {
          setLoading(false)
        }
        if (pendingRefreshRef.current && mountedRef.current && !refreshInFlightRef.current) {
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

  useEffect(() => {
    mountedRef.current = true
    const requestTokens = requestTokensRef.current
    const publicationGate = publicationGateRef.current
    return () => {
      mountedRef.current = false
      publicationGate.cancel()
      pendingRefreshRef.current = false
      pendingForceRef.current = false
      pendingBackgroundRef.current = true
      refreshIdRef.current += 1
      refreshInFlightRef.current = false
      for (const requestToken of requestTokens) {
        void window.api.aiVault.cancelListSessions({ requestToken })
      }
      requestTokens.clear()
    }
  }, [])

  // Panel entry reuses the renderer result, else paints the last list while the host answers.
  useEffect(() => {
    publicationGateRef.current.cancel()
    pendingRefreshRef.current = false
    pendingForceRef.current = false
    pendingBackgroundRef.current = true
    if (refreshInFlightRef.current) {
      for (const requestToken of requestTokensRef.current) {
        void window.api.aiVault.cancelListSessions({ requestToken })
      }
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

  useAiVaultNewSessionRescan(refresh)

  // A stale list keeps the scope pending, so it shows as refreshing until the rescan answers.
  const scopePending =
    (scan?.scopeKey !== scanScopeKey || scan?.stale === true) && terminalScopeKey !== scanScopeKey
  return {
    error,
    loading: loading || scopePending,
    scopePending,
    refresh,
    scanResult: shown?.result ?? null,
    sessions: shown?.result.sessions ?? EMPTY_AI_VAULT_SESSIONS,
    loadedSessionLimit: shown?.limit ?? null
  }
}
