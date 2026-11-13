// PARITY-FOLLOW: what each teammate is doing now, from the team workspace list's live presence.
import type { CloudWorkspace } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { formatWorkspaceNumber } from '../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { repoLabel } from '@/components/cloud-workspaces/cloud-workspace-format'
import type { SidebarFollowedWorkspace, SidebarTeammate } from './SidebarTeamSections'

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

/**
 * One row per teammate, in roster order: typing wins over viewing, and the most recent presence
 * wins between workspaces of the same state.
 */
export function teammateActivities(
  memberIds: readonly string[],
  workspaces: readonly CloudWorkspace[] | null
): SidebarTeammate[] {
  const best = new Map<string, { state: 'viewing' | 'typing'; at: number; label: string }>()
  for (const w of workspaces ?? []) {
    for (const p of w.presence) {
      const current = best.get(p.userId)
      const better =
        !current ||
        (p.state === 'typing' && current.state !== 'typing') ||
        (p.state === current.state && p.at > current.at)
      if (better) {
        best.set(p.userId, { state: p.state, at: p.at, label: workspaceDisplayLabel(w) })
      }
    }
  }
  return memberIds.map((userId) => {
    const found = best.get(userId)
    return {
      userId,
      activity: found ? { state: found.state, workspaceLabel: found.label } : null
    }
  })
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
