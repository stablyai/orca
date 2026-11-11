import { useAppStore } from '@/store'
import { useCloudWorkspaceView } from '../use-cloud-workspace-view'

/** The active workspace's id when it is an Orca Cloud workspace that is asleep (or failed to wake). */
export function useAsleepCloudWorkspaceId(): string | null {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const view = useCloudWorkspaceView(activeWorktreeId ?? '')
  if (!activeWorktreeId || !view.isCloud) {
    return null
  }
  return view.state === 'sleeping' || view.state === 'wakeFailed' ? activeWorktreeId : null
}
