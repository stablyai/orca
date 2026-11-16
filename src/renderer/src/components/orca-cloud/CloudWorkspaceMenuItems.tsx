import React, { useContext } from 'react'
import { useCloudTeamSharingEnabled } from '@/lib/orca-cloud/cloud-team-sharing-flag'
import { ArchiveSnapshotTooltip } from './ArchiveSnapshotTooltip'
import { toast } from 'sonner'
import { Archive, ArchiveRestore, Link2, Lock, RotateCw, Users } from 'lucide-react'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { toastSharedWithTeam } from '@/components/cloud-workspaces/shared-with-team-toast'
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
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
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
  hostId,
  moveItem = null
}: {
  worktreeId: string
  hostId?: string | null
  /** "Move to this computer", in the top group right after Restart (the sidebar passes it). */
  moveItem?: React.ReactNode
}): React.JSX.Element | null {
  // PAIRED-ARCHIVE: a paired row gets the same lifecycle rows (each action decides for itself).
  const view = useCloudWorkspaceView(worktreeId, { pairedRows: true })
  if (!view.isCloud) {
    return null
  }
  return (
    <CloudMenuRows
      worktreeId={worktreeId}
      hostId={hostId ?? null}
      view={view}
      moveItem={moveItem}
    />
  )
}

function CloudMenuRows({
  worktreeId,
  hostId,
  view,
  moveItem
}: {
  worktreeId: string
  hostId: string | null
  view: ReturnType<typeof useCloudWorkspaceView>
  moveItem: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const actions = useCloudPanelActions(worktreeId, noop)
  const { workspace, loaded, reload } = useCloudWorkspaceRecord(worktreeId, hostId)
  const confirm = useContext(ConfirmationDialogContext)
  const busy = view.pending !== undefined
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
    canRestart: sidebarRestartOffered(view.state)
  })
  // Before the first status read lands (rows read it on mount, so rarely) Restart sits disabled in
  // its place; a running workspace, the usual answer, then enables it without moving any row.
  const statusUnknown = view.state === 'unknown'
  const has = (action: CloudWorkspaceAction): boolean =>
    groups.some((group) => group.actions.includes(action))
  return (
    <>
      {has('restart') && actions.onRestart ? (
        <DropdownMenuItem disabled={busy || statusUnknown} onSelect={actions.onRestart}>
          <RotateCw className="size-3.5" />
          {t('orcaCloudWorkspace.restart', 'Restart')}
        </DropdownMenuItem>
      ) : null}
      {moveItem}
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
      {/* Before the first answer for this row (it's fetched on row hover, so rarely), the rows
          show disabled instead of appearing under the pointer a moment later. */}
      {(workspace || !loaded) && (has('share') || has('makePrivate')) ? (
        <>
          <DropdownMenuSeparator />
          {has('share') ? (
            <DropdownMenuItem
              disabled={!workspace}
              onSelect={() =>
                workspace && void setVisibility(workspace, 'team', { reload, t, confirm })
              }
            >
              <Users className="size-3.5" />
              {t('auto.components.cloudWorkspaces.shareWithTeam', 'Share with team')}
            </DropdownMenuItem>
          ) : null}
          {has('makePrivate') ? (
            <DropdownMenuItem
              disabled={!workspace}
              onSelect={() =>
                workspace && void setVisibility(workspace, 'private', { reload, t, confirm })
              }
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

/** Restart is offered on a workspace that answers, or may: unknown keeps its place (disabled). */
export function sidebarRestartOffered(state: CloudDotState): boolean {
  return (
    state === 'running' || state === 'unresponsive' || state === 'failed' || state === 'unknown'
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
  if (visibility === 'team') {
    toastSharedWithTeam(t)
  } else {
    toast.success(
      t(
        'auto.components.cloudWorkspaces.nowPrivate',
        'Now private. Teammates’ devices were disconnected.'
      )
    )
  }
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
  const { workspace, loaded } = useCloudWorkspaceRecord(worktreeId, hostId ?? null)
  // SHARE-LINKS-HOLD: no way to produce a share link while it's held.
  const shareLinks = useCloudTeamSharingEnabled()
  // Not asked yet: disabled in place rather than appearing a moment later.
  if ((!workspace && loaded) || !shareLinks) {
    return null
  }
  return (
    <DropdownMenuItem
      disabled={!workspace}
      onSelect={() => workspace && void copyCloudWorkspaceLink(workspace.id)}
    >
      <Link2 className="size-3.5" />
      {workspace?.number
        ? t('auto.components.cloudWorkspaces.linkToNumber', 'Link to {{number}}', {
            number: formatWorkspaceNumber(workspace.number)
          })
        : t('auto.components.cloudWorkspaces.workspaceLinkOption', 'Workspace link')}
    </DropdownMenuItem>
  )
}
