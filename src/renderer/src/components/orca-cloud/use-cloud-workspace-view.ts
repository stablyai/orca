import { useEffect } from 'react'
import { useNow } from '@/hooks/use-now'
import { useIsSleepingWorktree } from '@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state'
import {
  deriveCloudDotState,
  visibleOom,
  type CloudDotState
} from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  refreshCloudWorkspaceStatus,
  useCloudWorkspace,
  type CloudStatusEntry
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type {
  CloudOomEvent,
  CloudWakeProgressEvent
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'

export type CloudWorkspaceView = {
  isCloud: boolean
  state: CloudDotState
  entry: CloudStatusEntry | undefined
  wake: CloudWakeProgressEvent | undefined
  oom: CloudOomEvent | null
  pending: 'restart' | 'archive' | 'unarchive' | undefined
}

/** Everything a cloud surface needs for one workspace; non-cloud workspaces read only `isCloud`. */
export function useCloudWorkspaceView(workspaceId: string): CloudWorkspaceView {
  const isCloud = useCloudWorkspace((s) => s.ids.has(workspaceId))
  const entry = useCloudWorkspace((s) => s.status[workspaceId])
  const wake = useCloudWorkspace((s) => s.wake[workspaceId])
  const oomEvent = useCloudWorkspace((s) => s.oom[workspaceId])
  const oomDismissed = useCloudWorkspace((s) => s.oomDismissed[workspaceId])
  const pending = useCloudWorkspace((s) => s.pending[workspaceId])
  const sleeping = useIsSleepingWorktree(workspaceId)
  // Sleep and wake run through the desktop; re-read the VM's state whenever the local record flips.
  useEffect(() => {
    if (isCloud) {
      void refreshCloudWorkspaceStatus(workspaceId)
    }
  }, [isCloud, sleeping, workspaceId])
  // A wake can go stale without a terminal event (window reloaded mid-wake); re-derive every 5s.
  const now = useNow(5_000, isCloud && wake !== undefined)
  return {
    isCloud,
    state: isCloud
      ? deriveCloudDotState({ status: entry?.status ?? null, wake, sleeping, now: Math.max(now, wake?.at ?? 0) })
      : 'unknown',
    entry,
    wake,
    oom: visibleOom(oomEvent, oomDismissed),
    pending
  }
}

/** Refreshes status on an interval while `enabled` (an open status panel polls every 5 s). */
export function useCloudStatusPolling(workspaceId: string, intervalMs: number, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    void refreshCloudWorkspaceStatus(workspaceId)
    const timer = setInterval(() => void refreshCloudWorkspaceStatus(workspaceId), intervalMs)
    return () => clearInterval(timer)
  }, [workspaceId, intervalMs, enabled])
}
