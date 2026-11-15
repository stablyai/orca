// PARITY-FOLLOW: the sidebar's Following section for a team account, under the nav and above
// Projects, from the shared live read of the team's workspaces. A personal account shows nothing.
// The team list itself lives in the web console.
import React, { useMemo } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useOrcaAccountKey } from '@/hooks/use-orca-account-key'
import {
  setCloudWorkspaceFollow,
  useTeamWorkspacesLive
} from '@/components/cloud-workspaces/team-workspaces-live'
import { openCloudWorkspace } from '@/components/cloud-workspaces/open-cloud-workspace'
import { useMemberDirectory } from '@/components/cloud-workspaces/use-cloud-workspace-row-actions'
import { useCloudWorkspacesAvailable } from '@/components/cloud-workspaces/use-cloud-workspaces'
import { SidebarFollowingSection } from './SidebarFollowingSection'
import { followedWorkspaces } from './followed-workspaces'

export function SidebarFollowingPanel(): React.JSX.Element | null {
  const t = useTranslate()
  const cloud = useAppStore((s) => s.orcaProfileAuthStatus?.cloud)
  const account = useOrcaAccountKey()
  const available = useCloudWorkspacesAvailable()
  const orgId = cloud?.activeOrgId ?? null
  const selfId = cloud?.userId ?? null
  const live = useTeamWorkspacesLive(orgId && available ? account : null)
  const { directory } = useMemberDirectory(orgId ?? undefined, live ?? [])
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
    <SidebarFollowingSection
      workspaces={followed}
      directory={directory}
      selfId={selfId}
      onOpen={open}
      onUnfollow={unfollow}
    />
  )
}
