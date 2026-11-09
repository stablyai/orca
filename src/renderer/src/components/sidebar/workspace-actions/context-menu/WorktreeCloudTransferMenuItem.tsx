import React, { useEffect, useState } from 'react'
import { Laptop } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { runOrcaCloudTransferToLocal } from '@/lib/orca-cloud-transfer-flow'

/** "Move to this computer" for Orca Cloud workspaces. Mounted only inside the open menu. */
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
    <DropdownMenuItem onSelect={() => void runOrcaCloudTransferToLocal(worktreeId)}>
      <Laptop className="size-3.5" />
      {t(
        'auto.components.sidebar.WorktreeContextMenu.moveToThisComputer',
        'Move to this computer'
      )}
    </DropdownMenuItem>
  )
}
