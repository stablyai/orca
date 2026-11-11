import { useAppStore } from '@/store'
import { useCloudWorkspaceView } from '../use-cloud-workspace-view'

/**
 * The active workspace when it is an Orca Cloud workspace whose files can't be read right now:
 * asleep, waking (opening one wakes it), failed to wake, or archived. `waking` and `archived` say
 * which (an archived one is suspended too, but its copy must say archived, not asleep: DS-h).
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
  if (!activeWorktreeId || !view.isCloud) {
    return null
  }
  if (view.state === 'waking' || view.state === 'starting') {
    return { id: activeWorktreeId, waking: true, archived: false }
  }
  if (view.state === 'archived') {
    return { id: activeWorktreeId, waking: false, archived: true }
  }
  return view.state === 'sleeping' || view.state === 'wakeFailed' || vmSuspended
    ? { id: activeWorktreeId, waking: false, archived: false }
    : null
}
