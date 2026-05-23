import React, { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ProjectAddedContent } from './AddRepoSetupStep'
import type { WorkspaceCreateTelemetrySource } from '../../../../shared/types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'

type ProjectAddedModalData = {
  repoId?: string
  defaultWorktreeName?: string
  telemetrySource?: WorkspaceCreateTelemetrySource
}

export default function ProjectAddedDialog(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData as ProjectAddedModalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const repos = useAppStore((s) => s.repos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)

  const repoId = typeof modalData?.repoId === 'string' ? modalData.repoId : ''
  const repo = repos.find((candidate) => candidate.id === repoId) ?? null
  const isFolder = repo ? isFolderRepo(repo) : false
  const detected = repoId ? detectedWorktreesByRepo[repoId] : undefined
  const hiddenWorktreeCount =
    detected?.authoritative === true
      ? detected.worktrees.filter(
          (worktree) => !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
        ).length
      : 0
  const otherWorktreesVisible = repo
    ? effectiveExternalWorktreeVisibility(repo, isLegacyRepoForExternalWorktreeVisibility(repo)) ===
      'show'
    : false

  useEffect(() => {
    if (activeModal === 'project-added' && isFolder) {
      // Why: project-added is a Git setup step. Folder repos already activate
      // their synthetic root workspace and cannot create Git worktrees.
      closeModal()
    }
  }, [activeModal, closeModal, isFolder])

  const handleUseExistingWorktrees = useCallback(async () => {
    if (!repoId) {
      return
    }
    if (!otherWorktreesVisible) {
      await updateRepo(repoId, { externalWorktreeVisibility: 'show' })
      await fetchWorktrees(repoId)
    }
    closeModal()
  }, [closeModal, fetchWorktrees, otherWorktreesVisible, repoId, updateRepo])

  const handleCreateWorktree = useCallback(
    (name?: string) => {
      if (!repoId) {
        return
      }
      closeModal()
      openModal('new-workspace-composer', {
        initialRepoId: repoId,
        ...(name ? { prefilledName: name } : {}),
        telemetrySource: modalData?.telemetrySource ?? 'unknown'
      })
    },
    [closeModal, modalData?.telemetrySource, openModal, repoId]
  )

  const handleConfigureRepo = useCallback(() => {
    if (!repoId) {
      return
    }
    closeModal()
    openSettingsTarget({ pane: 'repo', repoId })
    openSettingsPage()
  }, [closeModal, openSettingsPage, openSettingsTarget, repoId])

  if (activeModal !== 'project-added' || !repo || isFolder) {
    return null
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent className="sm:max-w-lg">
        <ProjectAddedContent
          repoName={repo.displayName}
          hiddenWorktreeCount={hiddenWorktreeCount}
          defaultWorktreeName={modalData?.defaultWorktreeName}
          onUseExistingWorktrees={() => void handleUseExistingWorktrees()}
          onCreateWorktree={handleCreateWorktree}
          onConfigureRepo={handleConfigureRepo}
        />
      </DialogContent>
    </Dialog>
  )
}
