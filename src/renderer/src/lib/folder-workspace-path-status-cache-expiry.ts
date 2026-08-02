import { useEffect, useState } from 'react'
import { FOLDER_WORKSPACE_PATH_STATUS_TTL_MS } from '../../../shared/folder-workspace-path-status'

type FolderWorkspacePathStatusCacheClockEntry = {
  checkedAt: number
}

export function useFolderWorkspacePathStatusCacheExpiryTick(
  entries: Record<string, FolderWorkspacePathStatusCacheClockEntry>
): number {
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const now = Date.now()
    let nextDelayMs = Number.POSITIVE_INFINITY
    for (const entry of Object.values(entries)) {
      const delayMs = entry.checkedAt + FOLDER_WORKSPACE_PATH_STATUS_TTL_MS - now
      if (delayMs > 0) {
        nextDelayMs = Math.min(nextDelayMs, delayMs)
      }
    }
    if (!Number.isFinite(nextDelayMs)) {
      return
    }
    // Why: TTL freshness is derived from Date.now(), so subscribers need one
    // clock tick when the oldest cached status stops being authoritative.
    const timeout = window.setTimeout(() => setTick((value) => value + 1), nextDelayMs + 1)
    return () => window.clearTimeout(timeout)
  }, [entries, tick])

  return tick
}
