import React, { useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'

// Why: interpolated into the sentence so locales control where the name sits;
// U+0000 cannot appear in a real project name, so the split is unambiguous.
const NAME_TOKEN = '\u0000'

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''
  const requestedHostId =
    typeof modalData.hostId === 'string' ? (modalData.hostId as ExecutionHostId) : undefined
  const ownerRepo = useAppStore((s) =>
    findRepoForHost(s.repos, repoId, { hostId: requestedHostId, settings: s.settings })
  )
  const ownerHostId = ownerRepo ? getRepoExecutionHostId(ownerRepo) : requestedHostId
  const isProvisionedRoot = useAppStore((s) => {
    if (!ownerHostId) {
      return false
    }
    return (s.worktreesByRepo[repoId] ?? []).some(
      (worktree) =>
        getWorktreeExecutionHostId(worktree, ownerRepo ?? undefined, ownerHostId) === ownerHostId &&
        worktree.ephemeralVmCheckoutMode === 'provisioned-root'
    )
  })

  // Why: for an SSH project the files live on the remote host's disk, not the
  // user's — "still on your disk" would be misleading. Name the host (using the
  // removed-target label when it's a ghost) so the user knows where it remains
  // and that re-adding that host recovers it.
  const sshHostLabel = useAppStore((s) => {
    const connectionId = ownerRepo?.connectionId?.trim()
    if (!connectionId) {
      return null
    }
    return (
      s.sshTargetLabels.get(connectionId) ??
      s.removedSshTargetLabels.get(connectionId) ??
      connectionId
    )
  })

  // Why: fragment concatenation around the styled name cannot be reordered by
  // SOV locales (#9294). Translate one full sentence with the name as a
  // sentinel token, then split on it to re-apply the inline emphasis.
  const description = isProvisionedRoot
    ? translate(
        'auto.components.sidebar.RemoveFolderDialog.removeDescriptionProvisionedRoot',
        'This removes {{name}} from Orca and cleans up its provisioned environment according to the recipe.',
        { name: NAME_TOKEN }
      )
    : sshHostLabel
      ? translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionSsh',
          'This only removes {{name}} from Orca. Its files stay on {{host}} — re-add that SSH host to recover it.',
          { name: NAME_TOKEN, host: sshHostLabel }
        )
      : translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionLocal',
          'This only removes {{name}} from Orca. It is still on your disk.',
          { name: NAME_TOKEN }
        )
  const [descriptionBeforeName, descriptionAfterName] = description.split(NAME_TOKEN)

  const handleConfirm = useCallback(() => {
    if (repoId) {
      void removeProject(repoId, { hostId: ownerHostId, errorFeedback: 'toast' })
    }
    closeModal()
  }, [closeModal, ownerHostId, removeProject, repoId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.RemoveFolderDialog.b79b39d865', 'Remove Project')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {descriptionBeforeName}
            <span className="break-all font-medium text-foreground">{displayName}</span>
            {descriptionAfterName}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.sidebar.RemoveFolderDialog.d36883e046', 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {translate('auto.components.sidebar.RemoveFolderDialog.4dc5b5065b', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RemoveFolderDialog
