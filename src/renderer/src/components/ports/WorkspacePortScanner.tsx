import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getHasAnyWorktreesFromState } from '@/store/selectors'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  mergeWorkspacePortScans,
  WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY,
  scanWorkspacePortsForTarget,
  workspacePortScanKeyForTarget
} from '@/lib/workspace-port-actions'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/runtime-client-target'
import { installWindowVisibilityInterval, isWindowVisible } from '@/lib/window-visibility-interval'
import {
  reconcileTransientPortScanFailures,
  type PortScanDebounceState
} from '@/lib/workspace-port-scan-debounce'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'

const WORKSPACE_PORT_SCAN_INTERVAL_MS = 30_000
const WORKSPACE_PORT_ADVERTISED_URL_SETTLE_MS = 1_000
type WorkspacePortScannerRefreshOptions = {
  force?: boolean
  targets?: readonly RuntimeClientTarget[]
}
// Why: keep live ports through one dropped SSH/IPC scan while reachable empty scans clear now.
const WORKSPACE_PORT_SCAN_FAILURE_THRESHOLD = 2
// Why: advertised-URL events come from this app's own processes, whatever server is the default.
const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

function makeUnavailableScan(reason: string): WorkspacePortScanResult {
  return {
    platform: 'unknown',
    scannedAt: Date.now(),
    ports: [],
    unavailableReason: reason
  }
}

export function WorkspacePortScanner({ enabled = true }: { enabled?: boolean }): null {
  const settings = useAppStore((s) => s.settings)
  const repos = useAppStore((s) => s.repos)
  const hasWorktrees = useAppStore(getHasAnyWorktreesFromState)
  const setWorkspacePortScan = useAppStore((s) => s.setWorkspacePortScan)
  const setWorkspacePortScanProjection = useAppStore((s) => s.setWorkspacePortScanProjection)
  const replaceWorkspacePortScans = useAppStore((s) => s.replaceWorkspacePortScans)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const generationRef = useRef(0)
  const wasEnabledRef = useRef(false)
  const lastRefreshStartedAtByKeyRef = useRef(new Map<string, number>())
  const scanTargetsRef = useRef<RuntimeClientTarget[]>([])
  const portScanDebounceRef = useRef<PortScanDebounceState>(new Map())

  const scanTargets = useMemo(
    () =>
      buildExecutionHostRegistry({ repos, settings })
        .map((host) => runtimeRpcTargetForAuthorityKey(host.id))
        .filter((target): target is NonNullable<typeof target> => target !== null),
    [repos, settings]
  )
  const scanTargetsSignature = useMemo(
    () =>
      scanTargets
        .map((target) => workspacePortScanKeyForTarget(target))
        .sort()
        .join('\n'),
    [scanTargets]
  )
  scanTargetsRef.current = scanTargets

  const refresh = useCallback(
    (options: WorkspacePortScannerRefreshOptions = {}) => {
      const allTargets = scanTargetsRef.current
      if (!hasWorktrees || allTargets.length === 0) {
        portScanDebounceRef.current.clear()
        lastRefreshStartedAtByKeyRef.current.clear()
        setWorkspacePortScan(null)
        setWorkspacePortScanRefreshing(false)
        return Promise.resolve()
      }
      const requestedTargets = options.targets ?? allTargets
      if (requestedTargets.length === 0) {
        return Promise.resolve()
      }
      if (inFlightRef.current) {
        return inFlightRef.current
      }
      const now = Date.now()
      const targets = options.force
        ? requestedTargets
        : requestedTargets.filter((target) => {
            // Keep cadence per host so adding runtimes cannot restart healthy remote scans.
            const key = workspacePortScanKeyForTarget(target)
            const lastStartedAt = lastRefreshStartedAtByKeyRef.current.get(key)
            return (
              lastStartedAt === undefined || now - lastStartedAt >= WORKSPACE_PORT_SCAN_INTERVAL_MS
            )
          })
      if (targets.length === 0) {
        return Promise.resolve()
      }
      for (const target of targets) {
        lastRefreshStartedAtByKeyRef.current.set(workspacePortScanKeyForTarget(target), now)
      }

      const generation = generationRef.current
      setWorkspacePortScanRefreshing(true)
      const promise = Promise.all(
        targets.map(async (target) => {
          const key = workspacePortScanKeyForTarget(target)
          try {
            const result = await scanWorkspacePortsForTarget(target)
            return { key, result }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { key, result: makeUnavailableScan(message || 'Workspace port scan failed.') }
          }
        })
      )
        .then((results) => {
          if (generation === generationRef.current) {
            const activeTargetKeys = new Set(
              allTargets.map((target) => workspacePortScanKeyForTarget(target))
            )
            const publishedScans = useAppStore.getState().workspacePortScansByKey
            const reconciled = reconcileTransientPortScanFailures(
              results,
              publishedScans,
              portScanDebounceRef.current,
              WORKSPACE_PORT_SCAN_FAILURE_THRESHOLD,
              activeTargetKeys
            )
            const scansByKey = Object.fromEntries(
              Object.entries(publishedScans).filter(([key]) => activeTargetKeys.has(key))
            )
            // Late manual publishes can re-add pruned keys; remove inactive hosts again to prevent permanent unavailable notices.
            let sourceChanged =
              Object.keys(scansByKey).length !== Object.keys(publishedScans).length
            for (const { key, result } of reconciled) {
              sourceChanged ||= scansByKey[key] !== result
              scansByKey[key] = result
            }
            const merged = mergeWorkspacePortScans(scansByKey)
            const projectionKey =
              allTargets.length > 1
                ? WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY
                : workspacePortScanKeyForTarget(allTargets[0])
            if (sourceChanged || useAppStore.getState().workspacePortScan?.key !== projectionKey) {
              // Publish once per poll so large host sets cannot notify every subscriber once per host.
              replaceWorkspacePortScans(
                sourceChanged ? scansByKey : publishedScans,
                merged ? { key: projectionKey, result: merged } : null
              )
            }
          }
        })
        .finally(() => {
          if (inFlightRef.current === promise) {
            inFlightRef.current = null
          }
          if (generation === generationRef.current) {
            setWorkspacePortScanRefreshing(false)
          }
        })
      inFlightRef.current = promise
      return promise
    },
    [hasWorktrees, setWorkspacePortScan, replaceWorkspacePortScans, setWorkspacePortScanRefreshing]
  )

  useEffect(() => {
    if (!enabled) {
      wasEnabledRef.current = false
      return
    }
    if (!hasWorktrees) {
      wasEnabledRef.current = false
      portScanDebounceRef.current.clear()
      lastRefreshStartedAtByKeyRef.current.clear()
      setWorkspacePortScan(null)
      setWorkspacePortScanRefreshing(false)
      return
    }
    const wasDisabled = !wasEnabledRef.current
    wasEnabledRef.current = true
    generationRef.current += 1
    const targetKeys = new Set(
      scanTargetsRef.current.map((target) => workspacePortScanKeyForTarget(target))
    )
    for (const key of lastRefreshStartedAtByKeyRef.current.keys()) {
      if (!targetKeys.has(key)) {
        lastRefreshStartedAtByKeyRef.current.delete(key)
      }
    }
    const publishedScans = useAppStore.getState().workspacePortScansByKey
    const retainedEntries = Object.entries(publishedScans).filter(([key]) => targetKeys.has(key))
    const retainedScans =
      retainedEntries.length === Object.keys(publishedScans).length
        ? publishedScans
        : Object.fromEntries(retainedEntries)
    const retainedProjection = mergeWorkspacePortScans(retainedScans)
    const retainedProjectionKey =
      targetKeys.size > 1 ? WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY : Object.keys(retainedScans)[0]
    // Retain unchanged hosts during replacement RPCs; remove departed hosts and synthetic aggregates immediately.
    const nextProjection =
      retainedProjection && retainedProjectionKey
        ? { key: retainedProjectionKey, result: retainedProjection }
        : null
    if (retainedScans === publishedScans) {
      setWorkspacePortScanProjection(nextProjection)
    } else {
      replaceWorkspacePortScans(retainedScans, nextProjection)
    }
    // Resuming after disable requires fresh cadence; enabled host-set changes probe only additions.
    const targetsToRefresh = wasDisabled
      ? scanTargetsRef.current
      : scanTargetsRef.current.filter(
          (target) => !retainedScans[workspacePortScanKeyForTarget(target)]
        )
    // Visible changes preserve retained hosts’ cadence; hidden additions get their targeted scan on reveal.
    let shouldRefreshOnlyNewTargets = isWindowVisible() || targetsToRefresh.length > 0

    // Scans may invoke remote IPC/shells; pause without visible UI and refresh immediately on return.
    const stopVisibleInterval = installWindowVisibilityInterval({
      run: () => void refresh(),
      runOnVisible: () => {
        if (shouldRefreshOnlyNewTargets) {
          shouldRefreshOnlyNewTargets = false
          if (targetsToRefresh.length > 0) {
            void refresh({ force: true, targets: targetsToRefresh })
          }
          return
        }
        void refresh({ force: true })
      },
      intervalMs: WORKSPACE_PORT_SCAN_INTERVAL_MS
    })

    return () => {
      generationRef.current += 1
      inFlightRef.current = null
      setWorkspacePortScanRefreshing(false)
      stopVisibleInterval()
    }
  }, [
    enabled,
    hasWorktrees,
    refresh,
    scanTargetsSignature,
    setWorkspacePortScan,
    setWorkspacePortScanProjection,
    setWorkspacePortScanRefreshing,
    replaceWorkspacePortScans
  ])

  useEffect(() => {
    if (!enabled) {
      return
    }

    let burstRefresh: Promise<void> | null = null
    let eventSequence = 0
    let disposed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const clearRetryTimer = (): void => {
      if (!retryTimer) {
        return
      }
      clearTimeout(retryTimer)
      retryTimer = null
    }

    const unsubscribe = window.api.workspacePorts.onAdvertisedUrlChanged(() => {
      eventSequence += 1
      const sequence = eventSequence
      clearRetryTimer()
      if (!isWindowVisible()) {
        burstRefresh = null
        return
      }
      // Keep the leading scan through the quiet window so sequential events share it too.
      burstRefresh ??= refresh({ force: true, targets: [LOCAL_TARGET] })
      void burstRefresh.finally(() => {
        if (disposed || sequence !== eventSequence) {
          return
        }
        if (!isWindowVisible()) {
          burstRefresh = null
          return
        }
        // URL output can precede lsof/netstat visibility; one settled rescan catches that startup race.
        retryTimer = setTimeout(() => {
          retryTimer = null
          burstRefresh = null
          if (disposed || sequence !== eventSequence || !isWindowVisible()) {
            return
          }
          void refresh({ force: true, targets: [LOCAL_TARGET] })
        }, WORKSPACE_PORT_ADVERTISED_URL_SETTLE_MS)
      })
    })

    return () => {
      disposed = true
      clearRetryTimer()
      unsubscribe()
    }
  }, [enabled, refresh])

  return null
}
