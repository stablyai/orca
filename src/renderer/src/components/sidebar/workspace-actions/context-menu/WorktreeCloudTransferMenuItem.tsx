import React, { useEffect, useState } from 'react'
import { Laptop, SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { translate } from '@/i18n/i18n'
import { runOrcaCloudTransferToLocal } from '@/lib/orca-cloud-transfer-flow'

async function copyCloudSshCommand(workspaceId: string): Promise<void> {
  const api = window.api?.orcaCloudWorkspace
  if (!api?.prepareSsh) {
    return
  }
  const toastId = `orca-cloud-ssh-${workspaceId}`
  toast.loading(translate('auto.lib.orcaCloudSsh.preparing', 'Setting up SSH…'), { id: toastId })
  const result = await api.prepareSsh({ workspaceId })
  if (!result.ok) {
    toast.error(translate('auto.lib.orcaCloudSsh.failed', 'Could not set up SSH'), {
      id: toastId,
      description: result.message
    })
    return
  }
  await navigator.clipboard.writeText(result.value.command)
  toast.success(translate('auto.lib.orcaCloudSsh.copied', 'SSH command copied'), {
    id: toastId,
    duration: 10_000,
    description: translate(
      'auto.lib.orcaCloudSsh.copiedDetail',
      'Works from any terminal and wakes the workspace if it is asleep. For your editor, add {{line}} to ~/.ssh/config.',
      { line: result.value.includeLine }
    )
  })
}

/** "Move to this computer" and "Copy SSH command" for Orca Cloud workspaces. Mounted only inside the open menu. */
export function WorktreeCloudTransferMenuItem({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const [isCloud, setIsCloud] = useState(false)
  useEffect(() => {
    let live = true
    const api = window.api?.orcaCloudWorkspace
    if (!api?.prepareTransferToLocal) {
      return
    }
    void api
      .listCloudWorkspaceIds()
      .then((ids) => live && setIsCloud(ids.includes(worktreeId)))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [worktreeId])
  if (!isCloud) {
    return null
  }
  return (
    <>
      <DropdownMenuItem onSelect={() => void copyCloudSshCommand(worktreeId)}>
        <SquareTerminal className="size-3.5" />
        {t('auto.components.sidebar.WorktreeContextMenu.copySshCommand', 'Copy SSH command')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void runOrcaCloudTransferToLocal(worktreeId)}>
        <Laptop className="size-3.5" />
        {t(
          'auto.components.sidebar.WorktreeContextMenu.moveToThisComputer',
          'Move to this computer'
        )}
      </DropdownMenuItem>
    </>
  )
}
