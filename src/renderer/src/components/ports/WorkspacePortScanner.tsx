import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useAppStore } from '@/store'
import { getHasAnyWorktreesFromState } from '@/store/selectors'
import { getActiveRuntimeTarget, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  mergeWorkspacePortScans,
  runtimeTargetForExecutionHostId,
  scanWorkspacePortsForTarget,
  workspacePortScanKeyForTarget
} from '@/lib/workspace-port-actions'
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
  const setWorkspacePortScanForKey = useAppStore((s) => s.setWorkspacePortScanForKey)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const generationRef = useRef(0)
  const wasEnabledRef = useRef(false)
  const lastRefreshStartedAtByKeyRef = useRef(new Map<string, number>())
  const scanTargetsRef = useRef<RuntimeClientTarget[]>([])
  const portScanDebounceRef = useRef<PortScanDebounceState>(new Map())

  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(settings), [settings])
  const scanKey = workspacePortScanKeyForTarget(runtimeTarget)
  const scanTargets = useMemo(
    () =>
      buildExecutionHostRegistry({ repos, settings })
        .map((host) => runtimeTargetForExecutionHostId(host.id))
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
            // Why: each host keeps its own cadence so a newly added runtime cannot restart
            // healthy hosts' remote scans.
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
            const reconciled = reconcileTransientPortScanFailures(
              results,
              useAppStore.getState().workspacePortScansByKey,
              portScanDebounceRef.current,
              WORKSPACE_PORT_SCAN_FAILURE_THRESHOLD,
              activeTargetKeys
            )
            const scansByKey = Object.fromEntries(
              Object.entries(useAppStore.getState().workspacePortScansByKey).filter(([key]) =>
                activeTargetKeys.has(key)
              )
            )
            let sourceChanged = false
            for (const { key, result } of reconciled) {
              sourceChanged ||= scansByKey[key] !== result
              scansByKey[key] = result
              setWorkspacePortScanForKey(key, result)
            }
            const activeScan = scansByKey[scanKey]
            const merged = mergeWorkspacePortScans(scansByKey)
            const projectionKey =
              allTargets.length > 1
                ? 'all-hosts:all'
                : activeScan
                  ? scanKey
                  : workspacePortScanKeyForTarget(allTargets[0])
            if (sourceChanged || useAppStore.getState().workspacePortScan?.key !== projectionKey) {
              setWorkspacePortScanProjection(
                merged
                  ? {
                      key: projectionKey,
                      result: merged
                    }
                  : null
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
    [
      hasWorktrees,
      scanKey,
      setWorkspacePortScan,
      setWorkspacePortScanProjection,
      setWorkspacePortScanForKey,
      setWorkspacePortScanRefreshing
    ]
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
      targetKeys.size > 1 ? 'all-hosts:all' : Object.keys(retainedScans)[0]
    // Why: unchanged hosts stay visible while the replacement RPC runs; removed
    // hosts and the old synthetic aggregate are excluded immediately.
    const nextProjection =
      retainedProjection && retainedProjectionKey
        ? { key: retainedProjectionKey, result: retainedProjection }
        : null
    if (retainedScans === publishedScans) {
      setWorkspacePortScanProjection(nextProjection)
    } else {
      replaceWorkspacePortScans(retainedScans, nextProjection)
    }
    // Why: a scanner resumed after being disabled has no trustworthy cadence; a
    // host-set change while it stays enabled only probes the new host.
    const targetsToRefresh = wasDisabled
      ? scanTargetsRef.current
      : scanTargetsRef.current.filter(
          (target) => !retainedScans[workspacePortScanKeyForTarget(target)]
        )
    // Why: a visible target change should not restart retained hosts; a hidden
    // addition still needs its targeted scan when the window becomes visible.
    let shouldRefreshOnlyNewTargets = isWindowVisible() || targetsToRefresh.length > 0

    // Why: workspace port scans can cross runtime IPC or shell out remotely.
    // Keep the timer stopped while no UI can display the result; visibility
    // changes run one immediate refresh on return.
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
    if (runtimeTarget.kind !== 'local') {
      return
    }

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
        return
      }
      void refresh({ force: true, targets: [runtimeTarget] }).finally(() => {
        if (disposed || sequence !== eventSequence || !isWindowVisible()) {
          return
        }
        // Why: some dev servers print their URL just before the listener is
        // visible to lsof/netstat. One quiet settle scan catches that startup race.
        retryTimer = setTimeout(() => {
          if (disposed || sequence !== eventSequence || !isWindowVisible()) {
            return
          }
          void refresh({ force: true, targets: [runtimeTarget] })
        }, WORKSPACE_PORT_ADVERTISED_URL_SETTLE_MS)
      })
    })

    return () => {
      disposed = true
      clearRetryTimer()
      unsubscribe()
    }
  }, [enabled, refresh, runtimeTarget])

  return null
}
