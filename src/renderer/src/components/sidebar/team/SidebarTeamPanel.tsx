// PARITY-FOLLOW: the sidebar's Team list for a team account, under the nav and above Projects.
// Who is on the team comes from the roster; what each teammate is doing now comes from the shared
// live read of the team's workspaces. A personal account, or a team of one, shows nothing.
import React, { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import { useOrgRoster } from '@/components/billing/team/use-org-roster'
import { openCloudWorkspacePicker } from '@/components/cloud-workspaces/cloud-workspace-picker-store'
import { useTeamWorkspacesLive } from '@/components/cloud-workspaces/team-workspaces-live'
import { useMemberDirectory } from '@/components/cloud-workspaces/use-cloud-workspace-row-actions'
import { useCloudWorkspacesAvailable } from '@/components/cloud-workspaces/use-cloud-workspaces'
import { openTeammateProfile } from '@/components/teammates/teammate-profile-store'
import { SidebarTeamList } from './SidebarTeamSections'
import { teammateActivities } from './team-activity'

export function SidebarTeamPanel(): React.JSX.Element | null {
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
  if (!orgId || !available) {
    return null
  }
  return (
    <SidebarTeamList
      members={members}
      directory={directory}
      selfId={selfId}
      onOpenProfile={openTeammateProfile}
      onShowWorkspaces={(userId) => openCloudWorkspacePicker({ kind: 'teammate', userId })}
    />
  )
}
