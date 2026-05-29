import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
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
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type { Repo } from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { getProjectAddedPrimaryBranchName, SetupStep } from './AddRepoSetupStep'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'

const NON_GIT_REPO_ERROR = 'Not a valid git repository'

const AddProjectFromFolderDialog = React.memo(function AddProjectFromFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const openModal = useAppStore((s) => s.openModal)
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)

  const [addedRepo, setAddedRepo] = useState<Repo | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isOpen = activeModal === 'confirm-add-project-from-folder'
  const folderPath = typeof modalData.folderPath === 'string' ? modalData.folderPath : ''
  const connectionId = typeof modalData.connectionId === 'string' ? modalData.connectionId : ''
  const repoId = addedRepo?.id ?? ''

  const worktrees = useMemo(() => {
    return worktreesByRepo[repoId] ?? []
  }, [repoId, worktreesByRepo])
  const detectedResult = repoId ? detectedWorktreesByRepo[repoId] : undefined
  const hiddenWorktreeCount =
    detectedResult?.authoritative === true
      ? detectedResult.worktrees.filter(
          (worktree) => !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
        ).length
      : 0
  const otherWorktreesVisible = addedRepo
    ? effectiveExternalWorktreeVisibility(
        addedRepo,
        isLegacyRepoForExternalWorktreeVisibility(addedRepo)
      ) === 'show'
    : false
  const sortedWorktrees = useMemo(() => {
    return [...worktrees].sort((a, b) => {
      if (a.lastActivityAt !== b.lastActivityAt) {
        return b.lastActivityAt - a.lastActivityAt
      }
      return a.displayName.localeCompare(b.displayName)
    })
  }, [worktrees])
  const primaryWorktree = useMemo(
    () => sortedWorktrees.find((worktree) => worktree.isMainWorktree) ?? null,
    [sortedWorktrees]
  )
  const primaryBranchName = getProjectAddedPrimaryBranchName(primaryWorktree)

  useEffect(() => {
    if (!isOpen) {
      setAddedRepo(null)
      setIsAdding(false)
      setError(null)
    }
  }, [isOpen])

  const openNonGitConfirmation = useCallback(() => {
    closeModal()
    openModal('confirm-non-git-folder', {
      folderPath,
      ...(connectionId ? { connectionId } : {})
    })
  }, [closeModal, connectionId, folderPath, openModal])

  const handleConfirm = useCallback(async () => {
    if (!folderPath || isAdding) {
      return
    }
    setIsAdding(true)
    setError(null)
    try {
      let repo: Repo | null
      if (connectionId) {
        const result = await window.api.repos.addRemote({
          connectionId,
          remotePath: folderPath
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        repo = result.repo
        const state = useAppStore.getState()
        const existingIdx = state.repos.findIndex((r) => r.id === repo?.id)
        if (existingIdx !== -1) {
          state.clearOrcaHookTrustForRepo(repo.id)
          const updated = [...state.repos]
          updated[existingIdx] = repo
          useAppStore.setState({ repos: updated })
        } else {
          useAppStore.setState({ repos: [...state.repos, repo] })
        }
        toast.success('Remote project added', { description: repo.displayName })
      } else {
        repo = await addRepoPath(folderPath)
      }

      if (!repo) {
        return
      }
      if (!isGitRepoKind(repo)) {
        openNonGitConfirmation()
        return
      }
      setAddedRepo(repo)
      await fetchWorktrees(repo.id)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes(NON_GIT_REPO_ERROR)) {
        openNonGitConfirmation()
        return
      }
      setError(message)
    } finally {
      setIsAdding(false)
    }
  }, [addRepoPath, connectionId, fetchWorktrees, folderPath, isAdding, openNonGitConfirmation])

  const handleStartPrimaryWorktree = useCallback(() => {
    if (!primaryWorktree) {
      return
    }
    track('add_repo_setup_step_action', { action: 'open_primary' })
    closeModal()
    if (useAppStore.getState().hideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    activateAndRevealWorktree(primaryWorktree.id)
  }, [closeModal, primaryWorktree, setHideDefaultBranchWorkspace])

  const handleUseExistingWorktrees = useCallback(async () => {
    if (!repoId) {
      return
    }
    track('add_repo_setup_step_action', { action: 'open_existing' })
    if (!otherWorktreesVisible) {
      const updated = await updateRepo(repoId, { externalWorktreeVisibility: 'show' })
      if (updated && addedRepo) {
        setAddedRepo({ ...addedRepo, externalWorktreeVisibility: 'show' })
      }
    }
    closeModal()
    await fetchWorktrees(repoId)
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
  }, [addedRepo, closeModal, fetchWorktrees, otherWorktreesVisible, repoId, updateRepo])

  const handleCreateWorktree = useCallback(
    (name?: string) => {
      if (!repoId) {
        return
      }
      track('add_repo_setup_step_action', { action: 'create_worktree' })
      closeModal()
      setTimeout(() => {
        openModal('new-workspace-composer', {
          initialRepoId: repoId,
          ...(name ? { prefilledName: name } : {}),
          telemetrySource: 'sidebar'
        })
      }, 150)
    },
    [closeModal, openModal, repoId]
  )

  const handleConfigureRepo = useCallback(() => {
    if (!repoId) {
      return
    }
    track('add_repo_setup_step_action', { action: 'configure' })
    closeModal()
    openSettingsTarget({ pane: 'repo', repoId })
    openSettingsPage()
  }, [closeModal, openSettingsPage, openSettingsTarget, repoId])

  const handleSkip = useCallback(async () => {
    if (!repoId) {
      closeModal()
      return
    }
    track('add_repo_setup_step_action', { action: 'skip' })
    closeModal()
    await fetchWorktrees(repoId)
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
  }, [closeModal, fetchWorktrees, repoId])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (addedRepo) {
          void handleSkip()
          return
        }
        closeModal()
      }
    },
    [addedRepo, closeModal, handleSkip]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {addedRepo ? (
          <SetupStep
            repoName={addedRepo.displayName}
            hiddenWorktreeCount={hiddenWorktreeCount}
            primaryBranchName={primaryBranchName}
            onStartPrimaryWorktree={handleStartPrimaryWorktree}
            onUseExistingWorktrees={() => void handleUseExistingWorktrees()}
            onCreateWorktree={handleCreateWorktree}
            onConfigureRepo={handleConfigureRepo}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add Project</DialogTitle>
              <DialogDescription>Add this folder as a separate Orca project.</DialogDescription>
            </DialogHeader>

            {folderPath && (
              <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
                <div className="break-all font-mono text-muted-foreground">{folderPath}</div>
              </div>
            )}

            {error && <p className="text-xs text-destructive">{error}</p>}

            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isAdding}>
                Cancel
              </Button>
              <Button onClick={handleConfirm} disabled={!folderPath || isAdding}>
                {isAdding ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <FolderPlus className="size-4" />
                )}
                Add Project
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
})

export default AddProjectFromFolderDialog
