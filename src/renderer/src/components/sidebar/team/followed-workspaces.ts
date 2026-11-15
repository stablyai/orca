// PARITY-FOLLOW: the workspaces this member follows, from the team workspace list's live read.
import type { CloudWorkspace } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { formatWorkspaceNumber } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { repoLabel } from '@/components/cloud-workspaces/cloud-workspace-format'
import type { SidebarFollowedWorkspace } from './SidebarFollowingSection'

/** A workspace by name (people recognise names); its W-number, then its repo, as fallbacks. */
export function workspaceDisplayLabel(
  w: Pick<CloudWorkspace, 'title' | 'number' | 'repo' | 'id'>
): string {
  const title = w.title?.trim()
  if (title) {
    return title
  }
  if (w.number) {
    return formatWorkspaceNumber(w.number)
  }
  return w.repo ? repoLabel(w.repo.url) : w.id
}

function followedStatus(w: CloudWorkspace): SidebarFollowedWorkspace['status'] {
  if (w.archivedAt !== null) {
    return 'archived'
  }
  if (w.status === 'running') {
    return 'running'
  }
  return w.status === 'creating' || w.status === 'resuming' ? 'waking' : 'asleep'
}

/** Teammates' workspaces this member follows, most recently active first (PARITY-FOLLOW). */
export function followedWorkspaces(
  workspaces: readonly CloudWorkspace[] | null,
  selfId: string | null
): SidebarFollowedWorkspace[] {
  return (
    (workspaces ?? [])
      // Your own is the current owner's: a workspace handed to you leaves Following (FOLLOW-OWN-AFTER-TRANSFER).
      .filter((w) => w.following === true && w.ownerUserId !== selfId)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((w) => ({
        sandboxId: w.id,
        title: workspaceDisplayLabel(w),
        numberLabel: w.number ? formatWorkspaceNumber(w.number) : null,
        creatorId: w.createdBy,
        status: followedStatus(w),
        hereNow: new Set(w.presence.map((p) => p.userId).filter((id) => id !== selfId)).size
      }))
  )
}
