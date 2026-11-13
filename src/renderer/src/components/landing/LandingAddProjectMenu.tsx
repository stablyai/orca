// Landing's "Add project" opens the same Add project menu as the sidebar's folder button (browse,
// clone, create, a project host, and "Open cloud workspace…" with Orca Cloud), not the old modal.
import React, { useCallback } from 'react'
import { useAppStore } from '@/store'
import { AddProjectMenu } from '@/components/sidebar/project-admission/menu/AddProjectMenu'
import type { AddRepoDialogEntryRequest } from '@/components/sidebar/project-admission/dialog/add-repo-dialog-types'
import { useOpenCloudWorkspaceMenuItems } from '@/components/cloud-workspaces/OpenCloudWorkspaceMenuItem'

export function LandingAddProjectMenu({
  children
}: {
  /** The trigger: Landing's own button, so its look stays as upstream has it. */
  children: React.ReactNode
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const cloudItems = useOpenCloudWorkspaceMenuItems()
  const handleOpenEntryRequest = useCallback(
    (entryRequest: AddRepoDialogEntryRequest) => {
      openModal('add-repo', { entryRequest })
    },
    [openModal]
  )
  return (
    <AddProjectMenu
      side="bottom"
      align="start"
      onOpenEntryRequest={handleOpenEntryRequest}
      extraItems={cloudItems}
    >
      {children}
    </AddProjectMenu>
  )
}
