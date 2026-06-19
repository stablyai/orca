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
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import { buildExecutionHostRegistry } from '../../../../shared/execution-host-registry'

const WORKSPACE_PORT_SCAN_INTERVAL_MS = 30_000
const WORKSPACE_PORT_ADVERTISED_URL_SETTLE_MS = 1_000
type WorkspacePortScannerRefreshOptions = {
  force?: boolean
}

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
  const setWorkspacePortScanForKey = useAppStore((s) => s.setWorkspacePortScanForKey)
  const setWorkspacePortScanRefreshing = useAppStore((s) => s.setWorkspacePortScanRefreshing)
  const inFlightRef = useRef<Promise<void> | null>(null)
  const generationRef = useRef(0)
  const lastRefreshStartedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const scanTargetsRef = useRef<RuntimeClientTarget[]>([])

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
      const targets = scanTargetsRef.current
      if (!hasWorktrees || targets.length === 0) {
        setWorkspacePortScan(null)
        setWorkspacePortScanRefreshing(false)
        return Promise.resolve()
      }
      if (inFlightRef.current) {
        return inFlightRef.current
      }
      const now = Date.now()
      // Why: host/runtime state can rerender this singleton without changing the
      // desired poll cadence; remote scans must not restart on every such pass.
      if (
        !options.force &&
        now - lastRefreshStartedAtRef.current < WORKSPACE_PORT_SCAN_INTERVAL_MS
      ) {
        return Promise.resolve()
      }
      lastRefreshStartedAtRef.current = now

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
            const scansByKey = Object.fromEntries(results.map(({ key, result }) => [key, result]))
            for (const { key, result } of results) {
              setWorkspacePortScanForKey(key, result)
            }
            const activeScan = scansByKey[scanKey]
            const merged = mergeWorkspacePortScans(scansByKey)
            const projectionKey =
              results.length > 1 ? 'all-hosts:all' : activeScan ? scanKey : results[0].key
            setWorkspacePortScan(
              merged
                ? {
                    key: projectionKey,
                    result: merged
                  }
                : null
            )
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
      setWorkspacePortScanForKey,
      setWorkspacePortScanRefreshing
    ]
  )

  useEffect(() => {
    if (!enabled) {
      return
    }
    generationRef.current += 1
    setWorkspacePortScan(null)

    // Why: workspace port scans can cross runtime IPC or shell out remotely.
    // Keep the timer stopped while no UI can display the result; visibility
    // changes run one immediate refresh on return.
    const stopVisibleInterval = installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: WORKSPACE_PORT_SCAN_INTERVAL_MS
    })

    return () => {
      generationRef.current += 1
      inFlightRef.current = null
      stopVisibleInterval()
    }
  }, [enabled, refresh, scanTargetsSignature, setWorkspacePortScan])

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
      void refresh({ force: true }).finally(() => {
        if (disposed || sequence !== eventSequence || !isWindowVisible()) {
          return
        }
        // Why: some dev servers print their URL just before the listener is
        // visible to lsof/netstat. One quiet settle scan catches that startup race.
        retryTimer = setTimeout(() => {
          if (disposed || sequence !== eventSequence || !isWindowVisible()) {
            return
          }
          void refresh({ force: true })
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
