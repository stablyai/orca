// The delete dialog's Orca Cloud variant (DS-07): it names the sandbox and its disk, offers
// Archive instead, and deletes an asleep sandbox without waking it or a Force step (this dialog is
// the confirmation that its uncommitted changes go with it).
import type React from 'react'
import { useEffect, useState } from 'react'
import { Archive, Loader2, Trash2 } from 'lucide-react'
import { cloudSyncRemovalPreview } from '@/lib/orca-cloud/cloud-sync-store'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudSshWorktree } from '../cloud-ssh/use-cloud-ssh-status'
import { DeleteCloudSandboxAgentsNote } from './DeleteCloudSandboxAgentsNote'
import { useAppStore } from '@/store'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { CloudStateDot } from '@/components/orca-cloud/CloudStateDot'
import { cloudStateLabel } from '@/components/orca-cloud/cloud-state-copy'
import { useCloudWorkspaceView } from '@/components/orca-cloud/use-cloud-workspace-view'
import { runArchiveCloudWorkspace } from '@/components/orca-cloud/cloud-workspace-actions'

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
  return (
    <>
      <DialogTitle className="text-sm">
        {t('auto.components.sidebar.DeleteCloudWorkspace.title', 'Delete {{name}}?', {
          name: worktree.displayName ?? ''
        })}
      </DialogTitle>
      <DialogDescription>
        {t(
          'auto.components.sidebar.DeleteCloudWorkspace.body',
          "Deletes the sandbox and its disk, including chats, terminals and uncommitted changes. This can't be undone. To keep a snapshot, archive it instead."
        )}
      </DialogDescription>
      {/* The files live in the sandbox: name, repo and branch, and its state; no local path. */}
      <div className="mt-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs">
        <div className="truncate font-medium text-foreground">{worktree.displayName}</div>
        <div className="mt-0.5 flex items-center gap-1.5 text-muted-foreground">
          <CloudStateDot state={view.state} />
          <span>{cloudStateLabel(view.state, t)}</span>
          {where ? <span className="truncate">· {where}</span> : null}
        </div>
        {running && uncommittedCount !== undefined ? (
          <div className="mt-0.5 text-muted-foreground">
            {t(
              'auto.components.sidebar.DeleteCloudWorkspace.uncommitted',
              '{{count}} uncommitted changes',
              {
                count: uncommittedCount,
                defaultValue_one: '{{count}} uncommitted change'
              }
            )}
          </div>
        ) : null}
        {localCopy?.hasLocalCopy ? (
          <div className="mt-0.5 text-muted-foreground" data-cloud-sync-removal>
            {localCopy.editedHere > 0
              ? t(
                  'orcaCloudSync.removalEdited',
                  '{{count}} changed files on this computer will be removed.',
                  {
                    count: localCopy.editedHere,
                    defaultValue_one: '{{count}} changed file on this computer will be removed.'
                  }
                )
              : t('orcaCloudSync.removal', 'The copy on this computer is removed too.')}
          </div>
        ) : null}
      </div>
      <DeleteCloudSandboxAgentsNote worktree={worktree} />
    </>
  )
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

export function DeleteCloudWorkspaceFooter({
  isDeleting,
  onCancel,
  onArchive,
  onDelete,
  cancelButtonRef
}: {
  isDeleting: boolean
  onCancel: () => void
  onArchive: () => void
  onDelete: () => void
  /** Initial focus: deleting the sandbox is irreversible, so Enter must not do it. */
  cancelButtonRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <Button
        ref={cancelButtonRef}
        variant="ghost"
        size="sm"
        onClick={onCancel}
        disabled={isDeleting}
      >
        {t('auto.components.sidebar.DeleteCloudWorkspace.cancel', 'Cancel')}
      </Button>
      <Button variant="outline" size="sm" onClick={onArchive} disabled={isDeleting}>
        <Archive />
        {t('auto.components.sidebar.DeleteCloudWorkspace.archiveInstead', 'Archive instead')}
      </Button>
      <Button variant="destructive" size="sm" onClick={onDelete} disabled={isDeleting}>
        {isDeleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
        {t('auto.components.sidebar.DeleteCloudWorkspace.delete', 'Delete workspace')}
      </Button>
    </>
  )
}

/** "Archive instead": close the dialog and run the ordinary archive (Sleep, snapshot, Undo toast). */
export function archiveInsteadOfDelete(
  worktree: { id: string; displayName?: string },
  closeModal: () => void
): void {
  closeModal()
  void runArchiveCloudWorkspace(worktree.id, { name: worktree.displayName ?? null })
}
