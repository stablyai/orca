import React, { useCallback, useMemo } from 'react'
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
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import { countOpenRepoTerminalTabs } from '@/store/repos/repo-removal'
import { getRecipeVmSshTargetForHost } from '@/lib/recipe-vm-managed-host'
import { RemovalUnsavedFilesNotice } from './RemovalUnsavedFilesNotice'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { projectRemovalTargets } from './removal-unsaved-files'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

// NUL cannot occur in project names, so translated name-token splitting is unambiguous.
const NAME_TOKEN = '\u0000'

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  useUiLanguageRevision()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''
  const hostId =
    typeof modalData.hostId === 'string' ? normalizeExecutionHostId(modalData.hostId) : null

  // Remote files remain on the named host’s disk; ghost-host labels explain where recovery is possible.
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

  const onRecipeVmServer = useAppStore(
    (s) =>
      getRecipeVmSshTargetForHost(s.runtimeEnvironments, hostId) !== null ||
      (selectWorktreesByRepo(s)[repoId] ?? []).some(
        (worktree) =>
          worktree.hostId === hostId && worktree.ephemeralVmCheckoutMode === 'provisioned-root'
      )
  )

  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const detectedWorktreesByRepo = useAppStore((s) => selectDetectedWorktreesByRepo(s))
  const unsavedTargets = useMemo(
    () =>
      projectRemovalTargets(
        { worktreesByRepo, detectedWorktreesByRepo },
        repoId ? [{ repoId, hostId }] : []
      ),
    [detectedWorktreesByRepo, hostId, repoId, worktreesByRepo]
  )

  const openTerminalCount = useAppStore((s) =>
    repoId && hostId ? countOpenRepoTerminalTabs(s, repoId, hostId) : 0
  )
  const openTerminalWarning =
    openTerminalCount === 0
      ? null
      : translate(
          'auto.components.sidebar.RemoveFolderDialog.openTerminalWarning',
          '{{count}} open terminals in this project will be closed.',
          {
            count: openTerminalCount,
            defaultValue_one: '{{count}} open terminal in this project will be closed.'
          }
        )

  // Translate the whole sentence for reorderable locales, then restore emphasis at the name sentinel.
  const description =
    onRecipeVmServer || isRuntimeOwnedSshTargetId(sshConnectionId)
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

  const handleConfirm = useCallback(() => {
    // Require the opener’s host so same-ID rows on other hosts cannot be removed.
    if (repoId && hostId) {
      void removeProject(repoId, {
        hostId,
        errorFeedback: 'toast',
        confirmedDiscards: confirmUnsavedDiscard(useAppStore.getState, unsavedTargets)
      })
    }
    closeModal()
  }, [closeModal, hostId, removeProject, repoId, unsavedTargets])

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
      <DialogContent surface="security" className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.RemoveFolderDialog.b79b39d865', 'Remove Project')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {descriptionBeforeName}
            <span className="break-all font-medium text-foreground">{displayName}</span>
            {descriptionAfterName}
          </DialogDescription>
          {openTerminalWarning ? (
            <p className="text-xs font-medium text-foreground">{openTerminalWarning}</p>
          ) : null}
        </DialogHeader>
        <RemovalUnsavedFilesNotice targets={unsavedTargets} enabled={isOpen} />
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
