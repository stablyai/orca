import React, { useEffect } from 'react'
import { Monitor } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { openCloudRemoteDesktop } from '@/lib/cloud-remote-desktop/open-cloud-remote-desktop'
import {
  refreshCloudEnvironmentIds,
  useIsCloudEnvironment
} from '@/lib/cloud-remote-desktop/cloud-environment-ids'
import { useWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'

/** Orca Cloud workspaces only. Mounted only inside the open menu. */
export function WorktreeRemoteDesktopMenuItem({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const environmentId = useWorkspaceRuntimeEnvironmentId(worktreeId)
  const isCloud = useIsCloudEnvironment(environmentId)
  useEffect(() => {
    if (environmentId) {
      void refreshCloudEnvironmentIds()
    }
  }, [environmentId])
  if (!environmentId || !isCloud) {
    return null
  }
  return (
    <>
      <DropdownMenuItem onSelect={() => void openCloudRemoteDesktop(worktreeId, environmentId)}>
        <Monitor className="size-3.5" />
        {t('components.cloudRemoteDesktop.menuItem', 'Open Remote Desktop')}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  )
}
