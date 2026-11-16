import React from 'react'
import { Monitor } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { openMoveToThisComputer } from '@/lib/orca-cloud/orca-cloud-move-store'
import { useIsCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'

/**
 * "Move to this computer" for this desktop's own Orca Cloud workspaces. Reads the cloud workspace
 * store (the same list main serves, loaded before any menu opens), so it is there on the menu's
 * first paint instead of popping in after an IPC round trip.
 */
export function WorktreeCloudTransferMenuItem({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const isCloud = useIsCloudWorkspace(worktreeId)
  if (!isCloud || !window.api?.orcaCloudWorkspace?.prepareTransferToLocal) {
    return null
  }
  return (
    <DropdownMenuItem
      onSelect={() =>
        openMoveToThisComputer(
          worktreeId,
          findWorktreeById(useAppStore.getState(), worktreeId)?.displayName ?? worktreeId
        )
      }
    >
      <Monitor className="size-3.5" />
      {t('auto.components.sidebar.WorktreeContextMenu.moveToThisComputer', 'Move to this computer')}
    </DropdownMenuItem>
  )
}
