import React from 'react'
import { Monitor } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { openMoveToThisComputer } from '@/lib/orca-cloud/orca-cloud-move-store'
import { useCloudWorkspace, useIsCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useAppStore } from '@/store'
import { useCloudWorkspaceActions } from '@/components/orca-cloud/use-cloud-workspace-actions'
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
  const moving = useCloudWorkspace((s) => s.pending[worktreeId] === 'move')
  const actions = useCloudWorkspaceActions(worktreeId)
  if (
    !isCloud ||
    !window.api?.orcaCloudWorkspace?.prepareTransferToLocal ||
    !actions?.offers('moveToComputer')
  ) {
    return null
  }
  return (
    <DropdownMenuItem
      disabled={moving || !actions.allows('moveToComputer')}
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
