import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
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
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { selectNamedExecutionHostLabel } from '@/lib/execution-host-display-label'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'

// Why: interpolated into the sentence so locales control where the name sits;
// U+0000 cannot appear in a real project name, so the split is unambiguous.
const NAME_TOKEN = '\u0000'

// Why: a local removal returns in milliseconds, so show the spinner only once the call is slow
// enough to read as one — a remote host, not a flicker (docs/STYLEGUIDE.md).
const REMOVING_SPINNER_DELAY_MS = 200

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''
  const hostId = typeof modalData.hostId === 'string' ? (modalData.hostId as ExecutionHostId) : null

  // Why: no answer arrived from the owning host on the first attempt, so what it did is unknown.
  // The dialog stays open on that answer and re-offers the removal as a client-only forget.
  const [ownerUnverifiable, setOwnerUnverifiable] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [showRemovingSpinner, setShowRemovingSpinner] = useState(false)
  // Why: Cancel stays live while the host is being asked, and this dialog unmounts when the modal
  // closes. Bumping on teardown fences a late answer out of the invocation that replaced it.
  const removalTokenRef = useRef(0)
  useEffect(() => {
    setOwnerUnverifiable(false)
    setIsRemoving(false)
    return () => {
      removalTokenRef.current += 1
    }
  }, [isOpen, repoId, hostId])

  useEffect(() => {
    if (!isRemoving) {
      setShowRemovingSpinner(false)
      return
    }
    const timer = window.setTimeout(() => setShowRemovingSpinner(true), REMOVING_SPINNER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isRemoving])

  // Why: for an SSH project the files live on the remote host's disk, not the
  // user's — "still on your disk" would be misleading. Name the host (using the
  // removed-target label when it's a ghost) so the user knows where it remains
  // and that re-adding that host recovers it.
  const sshConnectionId = useAppStore(
    (s) =>
      s.repos
        .find((repo) => repo.id === repoId && (!hostId || getRepoExecutionHostId(repo) === hostId))
        ?.connectionId?.trim() ?? null
  )
  const sshHostLabel = useAppStore((s) => {
    if (!sshConnectionId) {
      return null
    }
    return (
      s.sshTargetLabels.get(sshConnectionId) ??
      s.removedSshTargetLabels.get(sshConnectionId) ??
      sshConnectionId
    )
  })
  // Why: an `ssh:` row answers owner-unverifiable too, and the modal can be opened without a
  // hostId (delete-worktree-flow), so resolve the owner the way removeProject will.
  const ownerHostId = useAppStore((s) => {
    if (hostId) {
      return hostId
    }
    const ownerRepo = findRepoForHost(s.repos, repoId, { settings: s.settings })
    return ownerRepo ? getRepoExecutionHostId(ownerRepo) : null
  })
  // Why: with the environment record gone — the very case this copy describes — the plain
  // resolver answers the routing id itself, and a slug like `env-a1b2` names nothing to the user.
  const resolvedOwnerLabel = useAppStore((s) =>
    ownerHostId ? selectNamedExecutionHostLabel(s, ownerHostId) : null
  )
  const ownerLabel =
    resolvedOwnerLabel ??
    translate('auto.components.sidebar.RemoveFolderDialog.unnamedOwnerHost', 'that host')

  // Why: the client-only forget goes through repos.removeForHost, which a paired web client does
  // not implement — it has one runtime and no records of its own to clear. Offering the button
  // there would guarantee a failure, so that client gets the explanation without the action.
  const canForgetLocally = !isPairedWebClientWindow()

  // Why: fragment concatenation around the styled name cannot be reordered by
  // SOV locales (#9294). Translate one full sentence with the name as a
  // sentinel token, then split on it to re-apply the inline emphasis.
  const description = ownerUnverifiable
    ? canForgetLocally
      ? translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionOwnerUnverifiable',
          'Orca could not confirm with {{host}} whether {{name}} was removed there. Removing it now clears this computer’s records only and sends nothing to {{host}}; if the project is still registered there, it comes back when that host reconnects.',
          { name: NAME_TOKEN, host: ownerLabel }
        )
      : translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionOwnerUnverifiableWeb',
          'Orca could not confirm with {{host}} whether {{name}} was removed there. This client keeps no records of its own to clear, so reconnect {{host}} and try again.',
          { name: NAME_TOKEN, host: ownerLabel }
        )
    : isRuntimeOwnedSshTargetId(sshConnectionId)
      ? translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionVmRecipe',
          'This removes {{name}} from Orca. Its VM recipe determines whether the environment and its files are permanently deleted.',
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

  const handleConfirm = useCallback(async () => {
    if (!repoId) {
      closeModal()
      return
    }
    const token = removalTokenRef.current
    setIsRemoving(true)
    const outcome = await removeProject(repoId, {
      ...(hostId ? { hostId } : {}),
      errorFeedback: 'toast',
      ...(ownerUnverifiable ? { mode: 'forget-local' as const } : {})
    })
    // Why: this invocation was cancelled or replaced while the host was being asked. closeModal is
    // global, so acting now would dismiss whichever dialog the user opened next.
    if (token !== removalTokenRef.current) {
      return
    }
    setIsRemoving(false)
    // Why: an unanswered host is not a failure to report and not a removal to celebrate — keep
    // the dialog open so the only honest remaining action is the one the user now sees.
    if (outcome.status === 'owner-unverifiable') {
      setOwnerUnverifiable(true)
      return
    }
    closeModal()
  }, [closeModal, hostId, ownerUnverifiable, removeProject, repoId])

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
          {ownerUnverifiable && !canForgetLocally ? null : (
            <Button
              variant="destructive"
              disabled={isRemoving}
              onClick={() => void handleConfirm()}
            >
              {showRemovingSpinner ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {ownerUnverifiable
                ? translate(
                    'auto.components.sidebar.RemoveFolderDialog.removeFromOrcaOnly',
                    'Remove from Orca'
                  )
                : translate('auto.components.sidebar.RemoveFolderDialog.4dc5b5065b', 'Remove')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RemoveFolderDialog
