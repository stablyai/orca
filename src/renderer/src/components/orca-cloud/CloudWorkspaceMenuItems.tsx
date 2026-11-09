import React, { useContext } from 'react'
import { Archive, ArchiveRestore, RotateCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ConfirmationDialogContext } from '@/components/confirmation-dialog-context'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import {
  runArchiveCloudWorkspace,
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace
} from './cloud-workspace-actions'

/** Workspace menu rows for Orca Cloud: Restart, Archive… (asks first) or Unarchive. */
export function CloudWorkspaceMenuItems({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const confirm = useContext(ConfirmationDialogContext)
  const view = useCloudWorkspaceView(worktreeId)
  if (!view.isCloud) {
    return null
  }
  const busy = view.pending !== undefined
  if (view.state === 'archived') {
    return (
      <DropdownMenuItem disabled={busy} onSelect={() => void runUnarchiveCloudWorkspace(worktreeId)}>
        <ArchiveRestore className="size-3.5" />
        {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
      </DropdownMenuItem>
    )
  }
  const canRestart =
    view.state === 'running' || view.state === 'unresponsive' || view.state === 'failed'
  const archive = async (): Promise<void> => {
    const ok = confirm
      ? await confirm({
          title: t('orcaCloudWorkspace.archiveTitle', 'Archive this workspace?'),
          description: t(
            'orcaCloudWorkspace.archiveDescription',
            'It stops and is kept as a snapshot. Its PRs, last changes and files stay browsable, and you can unarchive it.'
          ),
          confirmLabel: t('orcaCloudWorkspace.archive', 'Archive'),
          icon: Archive
        })
      : true
    if (ok) {
      await runArchiveCloudWorkspace(worktreeId)
    }
  }
  return (
    <>
      {canRestart ? (
        <DropdownMenuItem
          disabled={busy}
          onSelect={() => void runRestartCloudWorkspace(worktreeId)}
        >
          <RotateCw className="size-3.5" />
          {t('orcaCloudWorkspace.restartWorkspace', 'Restart workspace')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem disabled={busy || view.state === 'waking'} onSelect={() => void archive()}>
        <Archive className="size-3.5" />
        {t('orcaCloudWorkspace.archiveEllipsis', 'Archive…')}
      </DropdownMenuItem>
    </>
  )
}
