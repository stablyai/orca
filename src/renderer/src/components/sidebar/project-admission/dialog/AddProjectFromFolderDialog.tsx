import React, { useCallback, useRef, useState } from 'react'
import { FolderPlus, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store/index'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import { finishProjectAddWithDefaultCheckout } from '../completion/project-added-default-checkout'
import { captureCheckoutHandoffIntent } from '../completion/checkout-handoff-intent'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { worktreeRefreshOptions } from '../host-selection/add-repo-runtime-owner'

const NON_GIT_REPO_ERROR = 'Not a valid git repository'

const AddProjectFromFolderDialog = React.memo(function AddProjectFromFolderDialog() {
  const t = useTranslate()
  useUiLanguageRevision()
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const openModal = useAppStore((s) => s.openModal)
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)

  const [isAdding, setIsAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useMountedRef()
  const addGenRef = useRef(0)

  const isOpen = activeModal === 'confirm-add-project-from-folder'
  // A new request can replace this modal's data while it stays open; it is a new confirmation.
  const request = isOpen ? modalData : null
  const [previousRequest, setPreviousRequest] = useState(request)
  const folderPath = typeof modalData.folderPath === 'string' ? modalData.folderPath : ''
  const runtimeEnvironmentId =
    typeof modalData.runtimeEnvironmentId === 'string' ? modalData.runtimeEnvironmentId : null

  if (request !== previousRequest) {
    setPreviousRequest(request)
    // Clear the old request's state before commit so the new one cannot flash its progress/errors.
    addGenRef.current++
    setIsAdding(false)
    setError(null)
  }

  const openNonGitConfirmation = useCallback(() => {
    closeModal()
    openModal('confirm-non-git-folder', {
      folderPath,
      // Omitting runtimeEnvironmentId selects the local folder flow.
      ...(runtimeEnvironmentId ? { runtimeEnvironmentId } : {})
    })
  }, [closeModal, folderPath, openModal, runtimeEnvironmentId])

  const handleConfirm = useCallback(async () => {
    if (!folderPath || isAdding) {
      return
    }
    const gen = ++addGenRef.current
    // Bound before the add it authorizes: a replaced request, navigation or newer add releases it.
    const intent = captureCheckoutHandoffIntent()
    const isCurrent = (): boolean =>
      mountedRef.current && gen === addGenRef.current && intent.canReveal()
    setIsAdding(true)
    setError(null)
    try {
      let selectedPath = folderPath
      const repo = await addRepoPath(folderPath, 'git', {
        onResolvedSelectedPath: (resolved) => {
          selectedPath = resolved
        },
        // A replaced request must not open this add's non-Git prompt or error over its successor.
        canPublish: isCurrent,
        runtimeEnvironmentId
      })

      if (!isCurrent() || !repo) {
        return
      }
      if (!isGitRepoKind(repo)) {
        openNonGitConfirmation()
        return
      }
      // The repo is already persisted; a non-authoritative refresh must not strand the add dialog.
      const ownerOptions = worktreeRefreshOptions(runtimeEnvironmentId)
      await fetchWorktrees(repo.id, ownerOptions)
      if (!isCurrent()) {
        return
      }
      await finishProjectAddWithDefaultCheckout({
        repoId: repo.id,
        source: runtimeEnvironmentId ? 'runtime_server_path' : 'local_folder_picker',
        selectedPath,
        // The endpoint that admitted it; its adoption gave the row that endpoint's owner identity.
        executionHostId: ownerOptions.executionHostId,
        closeModal,
        intent
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(NON_GIT_REPO_ERROR)) {
        if (isCurrent()) {
          openNonGitConfirmation()
        }
        return
      }
      if (isCurrent()) {
        setError(message)
      }
    } finally {
      intent.dispose()
      if (mountedRef.current && gen === addGenRef.current) {
        setIsAdding(false)
      }
    }
  }, [
    addRepoPath,
    closeModal,
    fetchWorktrees,
    folderPath,
    isAdding,
    mountedRef,
    openNonGitConfirmation,
    runtimeEnvironmentId
  ])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        addGenRef.current++
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.sidebar.AddProjectFromFolderDialog.7d1f51678c', 'Add Project')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.sidebar.AddProjectFromFolderDialog.046751dbfb',
              'Add this folder as a separate Orca project.'
            )}
          </DialogDescription>
        </DialogHeader>

        {folderPath && (
          <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
            <div className="break-all font-mono text-muted-foreground">{folderPath}</div>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isAdding}>
            {t('auto.components.sidebar.AddProjectFromFolderDialog.7726a16374', 'Cancel')}
          </Button>
          <Button onClick={handleConfirm} disabled={!folderPath || isAdding}>
            {isAdding ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FolderPlus className="size-4" />
            )}
            {t('auto.components.sidebar.AddProjectFromFolderDialog.7d1f51678c', 'Add Project')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default AddProjectFromFolderDialog
