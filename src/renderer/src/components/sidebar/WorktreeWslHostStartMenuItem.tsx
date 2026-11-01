import React from 'react'
import { Play } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { startWslHostAndReloadProjects } from '@/lib/wsl-host-user-start'
import { useStoppedWslHost } from '../wsl-host-stopped/use-stopped-wsl-host'

/** Start for a workspace on a stopped WSL distro. Mounted only inside the open menu, so idle rows add no subscription. */
export function WorktreeWslHostStartMenuItem({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const stoppedWslHost = useStoppedWslHost(worktreeId)
  if (!stoppedWslHost) {
    return null
  }
  return (
    <>
      <DropdownMenuItem
        onSelect={() => void startWslHostAndReloadProjects(stoppedWslHost.environmentId)}
      >
        <Play className="size-3.5" />
        {translate('components.native-chat.hostOutage.startDistro', 'Start {{distro}}', {
          distro: stoppedWslHost.distro
        })}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  )
}
