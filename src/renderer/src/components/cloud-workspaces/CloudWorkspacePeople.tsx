// PARITY-FOLLOW: the people on the cloud workspace in front, beside its W-123 chip: its creator,
// its followers and who is here now, then Follow. Nothing for a local workspace, a personal
// account, or a workspace only you are on and nobody else could follow.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { openTeammateProfile } from '@/components/teammates/teammate-profile-store'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { sandboxIdForWorktree, useCloudWorkspaceIdentities } from './cloud-workspace-identity'
import { CloudWorkspaceFollowers, workspaceFollowerEntries } from './CloudWorkspaceFollowers'
import { setCloudWorkspaceFollow, useTeamWorkspacesLive } from './team-workspaces-live'
import { useMemberDirectory } from './use-cloud-workspace-row-actions'
import { useCloudWorkspacesAvailable } from './use-cloud-workspaces'

/**
 * Follow is offered on a teammate's team workspace; never on your own (it is yours already), and not
 * by a control plane that predates follows (`following` absent). "Your own" is the CURRENT owner:
 * after a hand-off the new owner gets no Follow and the creator does (FOLLOW-OWN-AFTER-TRANSFER).
 */
export function followOffer(workspace: CloudWorkspace, selfId: string | null): boolean | null {
  if (workspace.following === undefined || workspace.ownerUserId === selfId) {
    return null
  }
  return workspace.following
}

export function CloudWorkspacePeople({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const hostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const account = useOrcaAccountKey()
  const available = useCloudWorkspacesAvailable()
  const identities = useCloudWorkspaceIdentities()
  const [busy, setBusy] = useState(false)
  const orgId = cloud?.activeOrgId ?? null
  const selfId = cloud?.userId ?? null
  const sandboxId = sandboxIdForWorktree({ id: worktreeId, hostId }, identities)
  const live = useTeamWorkspacesLive(orgId && available && sandboxId ? account : null)
  const workspace = sandboxId ? (live?.find((w) => w.id === sandboxId) ?? null) : null
  const { directory } = useMemberDirectory(orgId ?? undefined, workspace ? [workspace] : [])
  if (!workspace) {
    return null
  }
  const following = followOffer(workspace, selfId)
  const entries = workspaceFollowerEntries({
    creatorId: workspace.createdBy,
    followers: workspace.followers ?? [],
    presence: workspace.presence
  })
  // Only you, on your own workspace: nothing to show.
  if (following === null && entries.every((e) => e.userId === selfId)) {
    return null
  }
  const toggle = (): void => {
    const next = !following
    setBusy(true)
    void setCloudWorkspaceFollow(workspace.id, next).then((ok) => {
      setBusy(false)
      if (!ok) {
        toast.error(
          next
            ? t('cloudFollow.followFailed', 'Couldn’t follow this workspace')
            : t('cloudFollow.unfollowFailed', 'Couldn’t unfollow this workspace')
        )
      }
    })
  }
  return (
    <CloudWorkspaceFollowers
      entries={entries}
      directory={directory}
      selfId={selfId}
      following={following}
      busy={busy}
      onToggleFollow={toggle}
      onOpenMember={(userId) => (userId === selfId ? undefined : openTeammateProfile(userId))}
    />
  )
}
