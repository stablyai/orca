// The delete dialog's Orca Cloud variant: it names the sandbox and its disk, offers
// Archive instead, and deletes an asleep sandbox without waking it or a Force step (this dialog is
// the confirmation that its uncommitted changes go with it). One whose repo has an archive hook is
// woken for the hook first, and the dialog says so.
import { ArchiveSnapshotTooltip } from '@/components/orca-cloud/ArchiveSnapshotTooltip'
import type React from 'react'
import { useEffect, useState } from 'react'
import { cloudSyncRemovalPreview } from '@/lib/orca-cloud/cloud-sync-store'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DialogCancel, DialogWarning } from '@/components/ui/dialog-parts'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudSshWorktree } from '../cloud-ssh/use-cloud-ssh-status'
import { DeleteCloudSandboxAgentsNote } from './DeleteCloudSandboxAgentsNote'
import { useAppStore } from '@/store'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { CloudStateDot } from '@/components/orca-cloud/CloudStateDot'
import { cloudStateLabel } from '@/components/orca-cloud/cloud-state-copy'
import { useCloudWorkspaceView } from '@/components/orca-cloud/use-cloud-workspace-view'
import { runArchiveCloudWorkspace } from '@/components/orca-cloud/cloud-workspace-actions'
import { useCloudWorkspaceActions } from '@/components/orca-cloud/use-cloud-workspace-actions'
import { cloudArchiveHookNeedsWake } from '@/components/orca-cloud/cloud-archive-hook-flow'
import { cloudWorkspaceTarget } from '@/lib/orca-cloud/orca-cloud-workspace-store'

const NOTE_CLASS = 'text-[12.5px] text-muted-foreground'

export function DeleteCloudWorkspaceHeader({
  worktree,
  dirtyCounts
}: {
  worktree: CloudSshWorktree & { displayName?: string; repoId?: string; branch?: string }
  /** Per-target change counts; only trusted while the sandbox runs (asleep, nothing can be checked). */
  dirtyCounts: ReadonlyMap<string, number>
}): React.JSX.Element {
  const uncommittedCount = dirtyCounts.get(
    worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
  )
  const t = useTranslate()
  const view = useCloudWorkspaceView(worktree.id)
  const repoName = useAppStore(
    (s) => s.repos.find((repo) => repo.id === worktree.repoId)?.displayName ?? null
  )
  const where = [repoName, worktree.branch?.replace(/^refs\/heads\//, '')]
    .filter(Boolean)
    .join(' · ')
  const running = view.state === 'running'
  const localCopy = useCloudSyncRemovalPreview(worktree.id)
  const hookWakes = useArchiveHookNeedsWake(worktree.id)
  // The unified confirm layout: question title, a meta line (state, repo, branch), the one
  // consequence line, then single lines below the header: amber for what is lost, muted otherwise.
  return (
    <>
      <DialogHeader>
        <DialogTitle className="break-all">
          {t('auto.components.sidebar.DeleteCloudWorkspace.title', 'Delete {{name}}?', {
            name: worktree.displayName ?? ''
          })}
        </DialogTitle>
        <DialogDescription size="compact">
          <span className="flex min-w-0 items-center gap-1.5">
            <CloudStateDot state={view.state} />
            <span>{cloudStateLabel(view.state, t)}</span>
            {where ? <span className="truncate">· {where}</span> : null}
          </span>
        </DialogDescription>
        <DialogDescription>
          {t(
            'auto.components.sidebar.DeleteCloudWorkspace.bodyNoSnapshot',
            'Deletes the workspace and all its files, chats and uncommitted changes. This can’t be undone.'
          )}
        </DialogDescription>
      </DialogHeader>
      {running && uncommittedCount !== undefined && uncommittedCount > 0 ? (
        <DialogWarning>
          {t(
            'auto.components.sidebar.DeleteCloudWorkspace.uncommitted',
            '{{count}} uncommitted changes',
            {
              count: uncommittedCount,
              defaultValue_one: '{{count}} uncommitted change'
            }
          )}
        </DialogWarning>
      ) : null}
      {localCopy?.hasLocalCopy ? (
        localCopy.editedHere > 0 ? (
          <DialogWarning data-cloud-sync-removal>
            {t(
              'orcaCloudSync.removalEdited',
              '{{count}} changed files on this computer will be removed.',
              {
                count: localCopy.editedHere,
                defaultValue_one: '{{count}} changed file on this computer will be removed.'
              }
            )}
          </DialogWarning>
        ) : (
          <p className={NOTE_CLASS} data-cloud-sync-removal>
            {t('orcaCloudSync.removal', 'The copy on this computer is removed too.')}
          </p>
        )
      ) : null}
      {hookWakes ? (
        <p className={NOTE_CLASS} data-cloud-archive-hook-wake>
          {t(
            'auto.components.sidebar.DeleteCloudWorkspace.archiveHookWake',
            'It wakes first to run the archive script in orca.yaml.'
          )}
        </p>
      ) : null}
      <DeleteCloudSandboxAgentsNote worktree={worktree} />
    </>
  )
}

/** An asleep workspace whose repo has a hook is woken for it before the delete. */
function useArchiveHookNeedsWake(workspaceId: string): boolean {
  const [needsWake, setNeedsWake] = useState(false)
  useEffect(() => {
    let live = true
    void cloudArchiveHookNeedsWake(cloudWorkspaceTarget(workspaceId)).then(
      (next) => live && setNeedsWake(next)
    )
    return () => {
      live = false
    }
  }, [workspaceId])
  return needsWake
}

/** What this computer synced from the workspace, for the line that says it goes too. */
function useCloudSyncRemovalPreview(
  workspaceId: string
): { hasLocalCopy: boolean; editedHere: number } | null {
  const [preview, setPreview] = useState<{ hasLocalCopy: boolean; editedHere: number } | null>(null)
  useEffect(() => {
    let live = true
    void cloudSyncRemovalPreview(workspaceId)
      .then((next) => live && setPreview(next))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [workspaceId])
  return preview
}

/**
 * Cancel, then Delete; "Archive" is the alternate on the left, like upstream's "Sleep workspace
 * instead". Focus starts on Cancel (the DialogContent's `initialFocus="cancel"`), as for local delete.
 */
export function DeleteCloudWorkspaceFooter({
  workspaceId,
  isDeleting,
  onArchive,
  onDelete
}: {
  /** LIFECYCLE-MATRIX: "Archive" only where archiving applies (never on an archived one). */
  workspaceId: string
  isDeleting: boolean
  onArchive: () => void
  onDelete: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const lifecycle = useCloudWorkspaceActions(workspaceId)
  const offersArchive = !lifecycle || lifecycle.offers('archiveInsteadOfDelete')
  return (
    <DialogFooter
      start={
        offersArchive ? (
          // What archive keeps, for how long, and that it costs no sandbox hours.
          <ArchiveSnapshotTooltip>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onArchive}
              disabled={isDeleting || lifecycle?.allows('archiveInsteadOfDelete') === false}
            >
              {t('auto.components.sidebar.DeleteCloudWorkspace.archiveInstead', 'Archive')}
            </Button>
          </ArchiveSnapshotTooltip>
        ) : null
      }
    >
      <DialogCancel disabled={isDeleting}>
        {t('auto.components.sidebar.DeleteCloudWorkspace.cancel', 'Cancel')}
      </DialogCancel>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={onDelete}
        disabled={isDeleting}
      >
        {isDeleting
          ? t('worktree.delete.deletingEllipsis', 'Deleting…')
          : t('auto.components.sidebar.DeleteCloudWorkspace.delete', 'Delete')}
      </Button>
    </DialogFooter>
  )
}

/** "Archive": close the dialog and run the ordinary archive (Sleep, snapshot, Undo toast). */
export function archiveInsteadOfDelete(
  worktree: { id: string; displayName?: string },
  closeModal: () => void
): void {
  closeModal()
  void runArchiveCloudWorkspace(worktree.id, { name: worktree.displayName ?? null })
}
