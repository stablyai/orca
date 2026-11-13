import React, { useContext } from 'react'
import { ArchiveSnapshotTooltip } from './ArchiveSnapshotTooltip'
import { toast } from 'sonner'
import {
  Archive,
  ArchiveRestore,
  HardDriveDownload,
  Link2,
  Lock,
  RotateCw,
  Users
} from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { isCloudSyncAvailable, requestCloudSyncFocus } from '@/lib/orca-cloud/cloud-sync-store'
import {
  ConfirmationDialogContext,
  type ConfirmationDialogContextValue
} from '@/components/confirmation-dialog-context'
import {
  cloudWorkspaceTitle,
  copyCloudWorkspaceLink
} from '@/components/cloud-workspaces/open-cloud-workspace'
import {
  cloudWorkspaceActionGroups,
  type CloudWorkspaceAction
} from '@/components/cloud-workspaces/cloud-workspace-action-groups'
import {
  formatWorkspaceNumber,
  type CloudWorkspace
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import { useCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { isPairedCloudStatusRow } from '@/lib/orca-cloud/orca-cloud-workspace-rows'
import { useCloudPanelActions } from './use-cloud-panel-actions'
import { useCloudWorkspaceRecord } from './use-cloud-workspace-record'

const noop = (): void => {}

/**
 * The sidebar's rows from the shared cloud workspace action list (JA-14): Lifecycle (Restart,
 * Archive or Unarchive; Sleep and Delete stay where the sidebar already has them) and Share
 * (Copy workspace link, Share with team or Make private), the same actions as Home's menu.
 */
export function CloudWorkspaceMenuItems({
  worktreeId,
  hostId
}: {
  worktreeId: string
  hostId?: string | null
}): React.JSX.Element | null {
  // PAIRED-ARCHIVE: a paired row gets the same lifecycle rows (each action decides for itself).
  const view = useCloudWorkspaceView(worktreeId, { pairedRows: true })
  if (!view.isCloud) {
    return null
  }
  return <CloudMenuRows worktreeId={worktreeId} hostId={hostId ?? null} view={view} />
}

function CloudMenuRows({
  worktreeId,
  hostId,
  view
}: {
  worktreeId: string
  hostId: string | null
  view: ReturnType<typeof useCloudWorkspaceView>
}): React.JSX.Element {
  const t = useTranslate()
  const actions = useCloudPanelActions(worktreeId, noop)
  const { workspace, reload } = useCloudWorkspaceRecord(worktreeId, hostId)
  const confirm = useContext(ConfirmationDialogContext)
  const busy = view.pending !== undefined
  // Mirroring syncs this desktop's own cloud workspaces; a paired one has no synced copy here.
  const paired = useCloudWorkspace((state) => isPairedCloudStatusRow(state, worktreeId))
  const archived = view.state === 'archived'
  const groups = cloudWorkspaceActionGroups({
    surface: 'sidebar',
    status: workspace?.status ?? 'running',
    archivedAt: archived ? (workspace?.archivedAt ?? 0) : null,
    visibility: workspace?.visibility ?? 'private',
    canOpen: true,
    // Until the team record loads, the lifecycle rows this desktop can always run still show.
    canManage: workspace ? workspace.access === 'owner' : true,
    readableAsleep: false,
    canRestart: view.state === 'running' || view.state === 'unresponsive' || view.state === 'failed'
  })
  const has = (action: CloudWorkspaceAction): boolean =>
    groups.some((group) => group.actions.includes(action))
  return (
    <>
      {has('restart') && actions.onRestart ? (
        <DropdownMenuItem disabled={busy} onSelect={actions.onRestart}>
          <RotateCw className="size-3.5" />
          {t('orcaCloudWorkspace.restart', 'Restart')}
        </DropdownMenuItem>
      ) : null}
      {isCloudSyncAvailable() && view.state !== 'archived' && !paired ? (
        <DropdownMenuItem onSelect={() => requestCloudSyncFocus(worktreeId)}>
          <HardDriveDownload className="size-3.5" />
          {t('orcaCloudSync.menuItem', 'Mirror to this computer…')}
        </DropdownMenuItem>
      ) : null}
      {has('archive') && actions.onArchive ? (
        <ArchiveSnapshotTooltip side="left">
          <DropdownMenuItem disabled={busy || view.state === 'waking'} onSelect={actions.onArchive}>
            <Archive className="size-3.5" />
            {t('orcaCloudWorkspace.archive', 'Archive')}
          </DropdownMenuItem>
        </ArchiveSnapshotTooltip>
      ) : null}
      {has('unarchive') && actions.onUnarchive ? (
        <DropdownMenuItem disabled={busy} onSelect={actions.onUnarchive}>
          <ArchiveRestore className="size-3.5" />
          {t('orcaCloudWorkspace.unarchive', 'Unarchive')}
        </DropdownMenuItem>
      ) : null}
      {workspace && (has('share') || has('makePrivate')) ? (
        <>
          <DropdownMenuSeparator />
          {has('share') ? (
            <DropdownMenuItem
              onSelect={() => void setVisibility(workspace, 'team', { reload, t, confirm })}
            >
              <Users className="size-3.5" />
              {t('auto.components.cloudWorkspaces.shareWithTeam', 'Share with team')}
            </DropdownMenuItem>
          ) : null}
          {has('makePrivate') ? (
            <DropdownMenuItem
              onSelect={() => void setVisibility(workspace, 'private', { reload, t, confirm })}
            >
              <Lock className="size-3.5" />
              {t('auto.components.cloudWorkspaces.makePrivate', 'Make private')}
            </DropdownMenuItem>
          ) : null}
        </>
      ) : null}
    </>
  )
}

async function setVisibility(
  workspace: CloudWorkspace,
  visibility: CloudWorkspace['visibility'],
  deps: {
    reload: () => void
    t: ReturnType<typeof useTranslate>
    confirm: ConfirmationDialogContextValue | null
  }
): Promise<void> {
  const { reload, t, confirm } = deps
  // Making it private takes access away from teammates: ask first, as Home does.
  if (visibility === 'private' && confirm) {
    const ok = await confirm({
      title: t('auto.components.cloudWorkspaces.makePrivateTitle', 'Make {{title}} private?', {
        title: cloudWorkspaceTitle(workspace, t)
      }),
      description: t(
        'auto.components.cloudWorkspaces.makePrivateSidebar',
        'Teammates’ devices are disconnected. Only the owner will be able to open it.'
      ),
      confirmLabel: t('auto.components.cloudWorkspaces.makePrivate', 'Make private')
    })
    if (!ok) {
      return
    }
  }
  const result = await window.api.cloudWorkspaces
    .patch(workspace.id, { visibility })
    .catch(() => null)
  if (!result?.ok) {
    toast.error(
      t(
        'auto.components.cloudWorkspaces.shareFailed',
        'Couldn’t change who can open it. Try again.'
      )
    )
    return
  }
  toast.success(
    visibility === 'team'
      ? t('auto.components.cloudWorkspaces.sharedWithYourTeam', 'Shared with your team')
      : t(
          'auto.components.cloudWorkspaces.nowPrivate',
          'Now private. Teammates’ devices were disconnected.'
        )
  )
  reload()
}

/** "Workspace link", first in the sidebar's Copy submenu for a cloud workspace (JA-14). */
export function CloudCopyWorkspaceLinkItem({
  worktreeId,
  hostId
}: {
  worktreeId: string
  hostId?: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const { workspace } = useCloudWorkspaceRecord(worktreeId, hostId ?? null)
  if (!workspace) {
    return null
  }
  return (
    <DropdownMenuItem onSelect={() => void copyCloudWorkspaceLink(workspace.id)}>
      <Link2 className="size-3.5" />
      {workspace.number
        ? t('auto.components.cloudWorkspaces.linkToNumber', 'Link to {{number}}', {
            number: formatWorkspaceNumber(workspace.number)
          })
        : t('auto.components.cloudWorkspaces.workspaceLinkOption', 'Workspace link')}
    </DropdownMenuItem>
  )
}
