// The delete dialog's Orca Cloud variant (DS-07): it names the sandbox and its disk, offers
// Archive instead, and deletes an asleep sandbox without waking it or a Force step (this dialog is
// the confirmation that its uncommitted changes go with it).
import type React from 'react'
import { Archive, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudSshWorktree } from '../cloud-ssh/use-cloud-ssh-status'
import { DeleteCloudSandboxAgentsNote } from './DeleteCloudSandboxAgentsNote'
import { runArchiveCloudWorkspace } from '@/components/orca-cloud/cloud-workspace-actions'

export function DeleteCloudWorkspaceHeader({
  worktree
}: {
  worktree: CloudSshWorktree & { displayName?: string }
}): React.JSX.Element {
  const t = useTranslate()
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
      <DeleteCloudSandboxAgentsNote worktree={worktree} />
    </>
  )
}

export function DeleteCloudWorkspaceFooter({
  isDeleting,
  onCancel,
  onArchive,
  onDelete,
  confirmButtonRef
}: {
  isDeleting: boolean
  onCancel: () => void
  onArchive: () => void
  onDelete: () => void
  confirmButtonRef: React.RefObject<HTMLButtonElement | null>
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <Button variant="ghost" size="sm" onClick={onCancel} disabled={isDeleting}>
        {t('auto.components.sidebar.DeleteCloudWorkspace.cancel', 'Cancel')}
      </Button>
      <Button variant="outline" size="sm" onClick={onArchive} disabled={isDeleting}>
        <Archive />
        {t('auto.components.sidebar.DeleteCloudWorkspace.archiveInstead', 'Archive instead')}
      </Button>
      <Button
        ref={confirmButtonRef}
        variant="destructive"
        size="sm"
        onClick={onDelete}
        disabled={isDeleting}
      >
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
