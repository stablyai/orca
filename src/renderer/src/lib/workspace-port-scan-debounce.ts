import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

export type KeyedPortScan = { key: string; result: WorkspacePortScanResult }

type PortScanDebounceEntry = {
  consecutiveFailures: number
  publishedResult: WorkspacePortScanResult
}

export type PortScanDebounceState = Map<string, PortScanDebounceEntry>

/** Keeps each host's last reachable scan through brief failures; reachable empty scans apply now. */
export function reconcileTransientPortScanFailures(
  results: KeyedPortScan[],
  publishedScans: Record<string, WorkspacePortScanResult>,
  state: PortScanDebounceState,
  failureThreshold: number,
  activeKeys: ReadonlySet<string> = new Set(results.map(({ key }) => key))
): KeyedPortScan[] {
  for (const key of state.keys()) {
    if (!activeKeys.has(key)) {
      state.delete(key)
    }
  }

  return results.map(({ key, result }) => {
    const previous = state.get(key)
    const publishedResult = publishedScans[key]
    // A different object was published by another refresh path, so it breaks this poller's streak.
    const previousFailures =
      previous && previous.publishedResult === publishedResult ? previous.consecutiveFailures : 0
    if (!result.unavailableReason) {
      state.set(key, { consecutiveFailures: 0, publishedResult: result })
      return { key, result }
    }
    const failures = previousFailures + 1
    const nextResult =
      failures < failureThreshold && publishedResult && !publishedResult.unavailableReason
        ? publishedResult
        : result
    state.set(key, { consecutiveFailures: failures, publishedResult: nextResult })
    return { key, result: nextResult }
  })
}
