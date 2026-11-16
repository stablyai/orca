import type React from 'react'
import { ArchiveSnapshotTooltip } from './ArchiveSnapshotTooltip'
import { Archive, ArchiveRestore, RotateCw } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import {
  cloudWorkspaceActionGroups,
  type CloudWorkspaceAction
} from '@/components/cloud-workspaces/cloud-workspace-action-groups'
import { useCloudWorkspaceView } from './use-cloud-workspace-view'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { useCloudPanelActions } from './use-cloud-panel-actions'
import { useCloudWorkspaceRecord } from './use-cloud-workspace-record'

const noop = (): void => {}

/**
 * The sidebar's rows from the shared cloud workspace action list: Lifecycle (Restart,
 * Archive or Unarchive; Sleep and Delete stay where the sidebar already has them), the same
 * actions as Home's menu.
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
  // A paired row gets the same lifecycle rows (each action decides for itself).
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
  const { workspace } = useCloudWorkspaceRecord(worktreeId, hostId)
  const busy = view.pending !== undefined
  const archived = view.state === 'archived'
  const groups = cloudWorkspaceActionGroups({
    surface: 'sidebar',
    status: workspace?.status ?? 'running',
    archivedAt: archived ? (workspace?.archivedAt ?? 0) : null,
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
    </>
  )
}

/** Restart is offered on a workspace that answers, or may: unknown keeps its place (disabled). */
export function sidebarRestartOffered(state: CloudDotState): boolean {
  return (
    state === 'running' || state === 'unresponsive' || state === 'failed' || state === 'unknown'
  )
}
