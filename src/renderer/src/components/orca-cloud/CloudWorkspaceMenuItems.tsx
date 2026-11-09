import React from 'react'
import { Archive, ArchiveRestore, RotateCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import { useCloudPanelActions } from './use-cloud-panel-actions'

const noop = (): void => {}

/** Workspace menu rows for Orca Cloud: Restart sandbox, Archive (with undo) or Unarchive. */
export function CloudWorkspaceMenuItems({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const view = useCloudWorkspaceView(worktreeId)
  if (!view.isCloud) {
    return null
  }
  return <CloudMenuRows worktreeId={worktreeId} view={view} />
}

function CloudMenuRows({
  worktreeId,
  view
}: {
  worktreeId: string
  view: ReturnType<typeof useCloudWorkspaceView>
}): React.JSX.Element {
  const t = useTranslate()
  const actions = useCloudPanelActions(worktreeId, noop)
  const busy = view.pending !== undefined
  if (view.state === 'archived') {
    return (
      <DropdownMenuItem disabled={busy} onSelect={actions.onUnarchive}>
        <ArchiveRestore className="size-3.5" />
        {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
      </DropdownMenuItem>
    )
  }
  const canRestart =
    view.state === 'running' || view.state === 'unresponsive' || view.state === 'failed'
  return (
    <>
      {canRestart ? (
        <DropdownMenuItem disabled={busy} onSelect={actions.onRestart}>
          <RotateCw className="size-3.5" />
          {t('orcaCloudWorkspace.restartSandbox', 'Restart sandbox')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem disabled={busy || view.state === 'waking'} onSelect={actions.onArchive}>
        <Archive className="size-3.5" />
        {t('orcaCloudWorkspace.archive', 'Archive')}
      </DropdownMenuItem>
    </>
  )
}
