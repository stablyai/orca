import React from 'react'
import { Archive, ArchiveRestore, RotateCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import {
  runArchiveCloudWorkspace,
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace
} from './cloud-workspace-actions'

/** Workspace menu rows for Orca Cloud: Restart, Archive or Unarchive. Nothing for other workspaces. */
export function CloudWorkspaceMenuItems({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const t = useTranslate()
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
  const canRestart = view.state === 'running' || view.state === 'unresponsive' || view.state === 'failed'
  return (
    <>
      {canRestart ? (
        <DropdownMenuItem disabled={busy} onSelect={() => void runRestartCloudWorkspace(worktreeId)}>
          <RotateCw className="size-3.5" />
          {t('orcaCloudWorkspace.restartVm', 'Restart cloud VM')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        disabled={busy || view.state === 'waking'}
        onSelect={() => void runArchiveCloudWorkspace(worktreeId)}
      >
        <Archive className="size-3.5" />
        {t('orcaCloudWorkspace.archive', 'Archive')}
      </DropdownMenuItem>
    </>
  )
}
