// PARITY-FOLLOW: the sidebar's Team list and Following section for a team account, under the nav
// and above Projects. Who is on the team comes from the roster; what each teammate is doing now, and
// which workspaces this member follows, from the shared live read of the team's workspaces. A
// personal account shows nothing; a team of one shows only what it follows.
import React, { useMemo } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { useOrgRoster } from '@/components/billing/team/use-org-roster'
import { openCloudWorkspacePicker } from '@/components/cloud-workspaces/cloud-workspace-picker-store'
import {
  setCloudWorkspaceFollow,
  useTeamWorkspacesLive
} from '@/components/cloud-workspaces/team-workspaces-live'
import { openCloudWorkspace } from '@/components/cloud-workspaces/open-cloud-workspace'
import { useMemberDirectory } from '@/components/cloud-workspaces/use-cloud-workspace-row-actions'
import { useCloudWorkspacesAvailable } from '@/components/cloud-workspaces/use-cloud-workspaces'
import { openTeammateProfile } from '@/components/teammates/teammate-profile-store'
import { SidebarFollowingSection, SidebarTeamList } from './SidebarTeamSections'
import { followedWorkspaces, teammateActivities } from './team-activity'

export function SidebarTeamPanel(): React.JSX.Element | null {
  const t = useTranslate()
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const account = useOrcaAccountKey()
  const available = useCloudWorkspacesAvailable()
  const orgId = cloud?.activeOrgId ?? null
  const selfId = cloud?.userId ?? null
  const live = useTeamWorkspacesLive(orgId && available ? account : null)
  const roster = useOrgRoster(orgId)
  const { directory } = useMemberDirectory(orgId ?? undefined, live ?? [])
  const memberIds = useMemo(
    () =>
      roster.result?.status === 'ok'
        ? roster.result.roster.members.flatMap((m) => (m.userId ? [m.userId] : []))
        : [],
    [roster.result]
  )
  const members = useMemo(() => teammateActivities(memberIds, live), [memberIds, live])
  const followed = useMemo(() => followedWorkspaces(live, selfId), [live, selfId])
  if (!orgId || !available) {
    return null
  }
  const open = (sandboxId: string): void => {
    const workspace = live?.find((w) => w.id === sandboxId)
    if (workspace) {
      void openCloudWorkspace(workspace)
    }
  }
  const unfollow = (sandboxId: string): void => {
    void setCloudWorkspaceFollow(sandboxId, false).then((ok) => {
      if (!ok) {
        toast.error(t('cloudFollow.unfollowFailed', 'Couldn’t unfollow this workspace'))
      }
    })
  }
  return (
    <>
      <SidebarTeamList
        members={members}
        directory={directory}
        selfId={selfId}
        onOpenProfile={openTeammateProfile}
        onShowWorkspaces={(userId) => openCloudWorkspacePicker({ kind: 'teammate', userId })}
      />
      <SidebarFollowingSection
        workspaces={followed}
        directory={directory}
        selfId={selfId}
        onOpen={open}
        onUnfollow={unfollow}
      />
    </>
  )
}
