import { useAppStore } from '@/store'
import { useIsWorktreeSleepViewHeld } from '@/lib/worktree-sleep-view'
import { useCloudWorkspaceView } from '../use-cloud-workspace-view'
import { isWakeReadyAfterRead } from '@/lib/orca-cloud/orca-cloud-workspace-state'

/**
 * The active workspace when it is an Orca Cloud workspace whose files can't be read right now:
 * asleep (or kept read-only while its Sleep runs), waking (opening one wakes it), failed to
 * wake, or archived. `waking` and `archived` say which (an archived one is suspended too,
 * but its copy must say archived, not asleep: DS-h).
 */
export function useAsleepCloudWorkspace(): {
  id: string
  waking: boolean
  archived: boolean
} | null {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const view = useCloudWorkspaceView(activeWorktreeId ?? '')
  // The local VM record flips as soon as this computer puts it to sleep; the control plane's status
  // can lag a poll behind, which left the read error showing right after Sleep.
  const vmSuspended = useAppStore((state) =>
    activeWorktreeId
      ? state.ephemeralVmRuntimesByWorkspaceId?.[activeWorktreeId]?.status === 'suspended' &&
        !state.wakingEphemeralVmWorkspaceIds?.[activeWorktreeId]
      : false
  )
  const viewOnly = useIsWorktreeSleepViewHeld(activeWorktreeId)
  if (!activeWorktreeId || !view.isCloud) {
    return null
  }
  if (view.state === 'waking' || view.state === 'starting') {
    return { id: activeWorktreeId, waking: true, archived: false }
  }
  if (view.state === 'archived') {
    return { id: activeWorktreeId, waking: false, archived: true }
  }
  // A ready wake newer than the reads: the VM record just hasn't caught up (no Wake button while
  // the terminal is "Connecting…").
  const staleSuspended = vmSuspended && !isWakeReadyAfterRead(view.wake, view.entry?.status)
  return view.state === 'sleeping' || view.state === 'wakeFailed' || staleSuspended || viewOnly
    ? { id: activeWorktreeId, waking: false, archived: false }
    : null
}
