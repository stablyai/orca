// PARITY-FOLLOW: the people on the cloud workspace in front, beside its W-123 chip. Phase 1 shows
// its creator and who is here now (the team list's live presence); Follow arrives with the follow
// endpoint. Nothing for a local workspace, a personal account, or a workspace only you are on.
import React from 'react'
import { useAppStore } from '@/store'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { openTeammateProfile } from '@/components/teammates/teammate-profile-store'
import { sandboxIdForWorktree, useCloudWorkspaceIdentities } from './cloud-workspace-identity'
import { CloudWorkspaceFollowers, workspaceFollowerEntries } from './CloudWorkspaceFollowers'
import { useTeamWorkspacesLive } from './team-workspaces-live'
import { useMemberDirectory } from './use-cloud-workspace-row-actions'
import { useCloudWorkspacesAvailable } from './use-cloud-workspaces'

export function CloudWorkspacePeople({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const hostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const account = useOrcaAccountKey()
  const available = useCloudWorkspacesAvailable()
  const identities = useCloudWorkspaceIdentities()
  const orgId = cloud?.activeOrgId ?? null
  const selfId = cloud?.userId ?? null
  const sandboxId = sandboxIdForWorktree({ id: worktreeId, hostId }, identities)
  const live = useTeamWorkspacesLive(orgId && available && sandboxId ? account : null)
  const workspace = sandboxId ? (live?.find((w) => w.id === sandboxId) ?? null) : null
  const { directory } = useMemberDirectory(orgId ?? undefined, workspace ? [workspace] : [])
  if (!workspace) {
    return null
  }
  const entries = workspaceFollowerEntries({
    creatorId: workspace.createdBy,
    followers: [],
    presence: workspace.presence
  })
  // Only you, on your own workspace: nothing to show.
  if (entries.every((e) => e.userId === selfId)) {
    return null
  }
  return (
    <CloudWorkspaceFollowers
      entries={entries}
      directory={directory}
      selfId={selfId}
      following={null}
      onOpenMember={(userId) => (userId === selfId ? undefined : openTeammateProfile(userId))}
    />
  )
}
