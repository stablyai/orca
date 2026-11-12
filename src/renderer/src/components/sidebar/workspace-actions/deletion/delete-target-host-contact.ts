// What the delete dialog may ask a target's host while it is open. An Orca Cloud workspace's host is
// its sandbox: any read there either wakes it or waits on a VM that is asleep, just to fill in a
// dialog. So a cloud target gets no ignored-files scan (its dialog shows no file list), and its git
// status is read only while it is awake (its dialog shows "N uncommitted changes" only then).
import { getCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import type { Worktree } from '../../../../../../shared/worktree/types'

export type DeleteTargetHostRead = 'git-status' | 'at-risk-scan'

export function mayContactDeleteTargetHost(
  target: Pick<Worktree, 'id'>,
  read: DeleteTargetHostRead
): boolean {
  const snapshot = getCloudWorkspaceSnapshot()
  if (!snapshot.ids.has(target.id)) {
    return true
  }
  if (read === 'at-risk-scan') {
    return false
  }
  return snapshot.status[target.id]?.status?.state === 'ready'
}
