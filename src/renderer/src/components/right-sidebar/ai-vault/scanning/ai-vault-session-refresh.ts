import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { aiVaultScanErrorText } from './ai-vault-scan-issue-copy'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host/execution-host'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'
import { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'
import { EMPTY_AI_VAULT_SESSIONS } from '../session-list/ai-vault-session-identity'
import { useAppliedAiVaultScan } from './ai-vault-applied-scan'
import { useAiVaultSessionHostRefreshEvents } from '../scope/ai-vault-host-scope'
import { aiVaultSessionResultCacheKey } from './ai-vault-session-result-cache'
import {
  refreshAiVaultSessionList,
  type AiVaultConditionalSnapshot,
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList,
  readLastAiVaultSessionList
} from './ai-vault-session-list-request'
import { useAiVaultNewSessionRescan } from './ai-vault-new-session-rescan'
import { saveAiVaultSessionList } from './ai-vault-saved-session-lists'
import { useAiVaultAssociationObservation } from './ai-vault-association-observation'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'
import { claimAiVaultForcedRescan } from './ai-vault-forced-rescan-budget'
import {
  type AiVaultListResult,
  type AiVaultSession,
  isAiVaultScanCancelledError as isAiVaultScanCancellation
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

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
  /** A foreground refresh is in flight, including while a cached list is shown without a spinner. */
  refreshing: boolean
  /** Changes when a different list is shown, so a wait can identify its own list. */
  listRevision: number
  scopePending: boolean
  refresh: (args?: AiVaultRefreshArgs) => Promise<void>
  scanResult: AiVaultListResult | null
  sessions: readonly AiVaultSession[]
  /** The depth the sessions on screen came from, which trails the selected one during a rescan. */
  loadedSessionLimit: AiVaultSessionLimit | null
} {
  const scanScopeKey = `${aiVaultSessionResultCacheKey(executionHostScope, scopePaths, scopeOnly)}\n${sessionLimit}`
  // A return to the panel opens on the list this scope already holds instead of a skeleton.
  const { scan, applyScan } = useAppliedAiVaultScan(() => {
    const result = readCachedAiVaultSessionList({
      scopePaths,
      scopeOnly,
      executionHostScope,
      sessionLimit
    })
    return result && { result, limit: sessionLimit, scopeKey: scanScopeKey, scopeOnly }
  })
  const associations = useAiVaultAssociationObservation(executionHostScope)
  const associationsRef = useRef(associations)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [listRevision, setListRevision] = useState(0)
  const [failure, setFailure] = useState<{ scopeKey: string; cause: string } | null>(null)
  const [terminalScopeKey, setTerminalScopeKey] = useState<string | null>(null)
  const requestTokenRef = useRef<string>(undefined!)
  requestTokenRef.current ??= createBrowserUuid()
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const pendingForceRef = useRef(false)
  const pendingBackgroundRef = useRef(true)
  const pendingForegroundRef = useRef(false)
  const conditionalSnapshotRef = useRef<(AiVaultConditionalSnapshot & { scopeKey: string }) | null>(
    null
  )
  const mountedRef = useRef(true)
  const publicationGateRef = useRef<AiVaultSessionPublicationGate>(undefined!)
  publicationGateRef.current ??= new AiVaultSessionPublicationGate()
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
      // Why: set at the request, not the launch, so a request queued behind another refresh counts while it waits.
      if (args.background !== true) {
        setRefreshing(true)
      }
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
      if (refreshInFlightRef.current) {
        pendingRefreshRef.current = true
        pendingForceRef.current ||= args.force === true
        pendingBackgroundRef.current &&= args.background === true || cachedResult !== null
        if (args.background !== true) {
          pendingForegroundRef.current = true
        }
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
      const requestCurrent = () =>
        mountedRef.current &&
        refreshIdRef.current === refreshId &&
        scanKey === currentScanScopeKey() &&
        associationCurrent()
      // Why: the finished list may wait for typing to pause; loading and the outstanding flag clear in the commit that shows it.
      // A launch that ends without handing a list to the gate (error, cancel, superseded first) clears them in finally instead,
      // keeping the flag for a queued foreground request. "Published" means accepted by the gate, not yet painted.
      let published = false
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
        published = true
        publicationGateRef.current.publish(result, (list) => {
          // A superseded list is dropped; the refresh that replaced it settles the flag instead.
          if (!requestCurrent()) {
            return
          }
          if (applyListed(list, true)) {
            setListRevision((revision) => revision + 1)
          }
          setLoading(false)
          // A queued foreground request keeps the flag until its own list lands.
          if (!(pendingRefreshRef.current && pendingForegroundRef.current)) {
            setRefreshing(false)
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
        // A published list settles both in its own commit; a queued foreground request already holds the flag.
        if (mountedRef.current && refreshIdRef.current === refreshId && !published) {
          setLoading(false)
          // A queued foreground request is still outstanding until its own refresh settles.
          setRefreshing(pendingRefreshRef.current && pendingForegroundRef.current)
        }
        if (pendingRefreshRef.current && mountedRef.current) {
          pendingRefreshRef.current = false
          const force = pendingForceRef.current
          // The queued refresh is background-only if every queued caller was.
          const background = pendingBackgroundRef.current
          pendingForceRef.current = false
          pendingBackgroundRef.current = true
          pendingForegroundRef.current = false
          void refresh({ force, background })
        }
      }
      // Read changing scope through refs; recursion requires a stable refresh identity.
    },
    [applyScan, currentScanScopeKey]
  )

  useEffect(() => {
    mountedRef.current = true
    const publicationGate = publicationGateRef.current
    return () => {
      mountedRef.current = false
      publicationGate.cancel()
      pendingRefreshRef.current = false
      pendingForceRef.current = false
      pendingBackgroundRef.current = true
      pendingForegroundRef.current = false
      refreshIdRef.current += 1
      refreshInFlightRef.current = false
      // The scan keeps running so the host caches it; the next visit joins it rather than restarting.
    }
  }, [])

  // Panel entry reuses the renderer result, else paints the last list while the host answers.
  useEffect(() => {
    publicationGateRef.current.cancel()
    pendingRefreshRef.current = false
    pendingForceRef.current = false
    pendingBackgroundRef.current = true
    pendingForegroundRef.current = false
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

  useAiVaultNewSessionRescan(refresh)

  // A stale list keeps the scope pending, so it shows as refreshing until the rescan answers.
  const scopePending =
    (scan?.scopeKey !== scanScopeKey || scan?.stale === true) && terminalScopeKey !== scanScopeKey
  return {
    error,
    loading: loading || scopePending,
    refreshing,
    listRevision,
    scopePending,
    refresh,
    scanResult: shown?.result ?? null,
    sessions: shown?.result.sessions ?? EMPTY_AI_VAULT_SESSIONS,
    loadedSessionLimit: shown?.limit ?? null
  }
}
