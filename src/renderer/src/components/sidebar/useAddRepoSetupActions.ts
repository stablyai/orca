import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { track } from '@/lib/telemetry'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { AddRepoSetupStepAction } from '../../../../shared/telemetry-events'
import type { Repo } from '../../../../shared/types'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import {
  buildAddRepoExistingWorkspacesTelemetry,
  shouldTrackAddRepoExistingWorkspacesDetected
} from './add-repo-existing-workspaces-telemetry'
import { getProjectAddedPrimaryBranchName } from './AddRepoSetupStep'

export function useAddRepoSetupActions({
  addedRepo,
  existingWorkspaceSource,
  isSetupStep,
  projectId,
  closeModal,
  openModal,
  openSettingsPage,
  openSettingsTarget,
  fetchWorktrees,
  resetState,
  setupActionGenRef,
  setAddedRepo
}: {
  addedRepo: Repo | null
  existingWorkspaceSource: AddRepoExistingWorkspaceSource | null
  isSetupStep: boolean
  projectId: string
  closeModal: () => void
  openModal: (
    modal: 'new-workspace-composer',
    data: { initialRepoId: string; prefilledName?: string; telemetrySource: 'sidebar' }
  ) => void
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: 'repo'; repoId: string }) => void
  fetchWorktrees: (repoId: string) => Promise<unknown>
  resetState: () => void
  setupActionGenRef: MutableRefObject<number>
  setAddedRepo: (repo: Repo | null) => void
}): {
  hiddenWorktreeCount: number
  primaryBranchName: string | null
  trackSetupAction: (action: AddRepoSetupStepAction) => void
  finishImportedRepoWithoutOpening: () => Promise<void>
  handleCreateWorktree: (name?: string) => void
  handleStartPrimaryWorktree: () => void
  handleConfigureRepo: () => void
  handleUseExistingWorktrees: () => Promise<void>
} {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const worktrees = useMemo(() => worktreesByRepo[projectId] ?? [], [worktreesByRepo, projectId])
  const detectedResult = projectId ? detectedWorktreesByRepo[projectId] : undefined
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

  // Why: sort by recent activity with alphabetical fallback.
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
  const existingWorkspaceTelemetry = useMemo(
    () => buildAddRepoExistingWorkspacesTelemetry(existingWorkspaceSource, sortedWorktrees),
    [existingWorkspaceSource, sortedWorktrees]
  )

  const detectedTelemetryTrackedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (
      !isSetupStep ||
      !projectId ||
      !existingWorkspaceTelemetry ||
      !shouldTrackAddRepoExistingWorkspacesDetected(existingWorkspaceTelemetry) ||
      detectedTelemetryTrackedRef.current.has(projectId)
    ) {
      return
    }
    detectedTelemetryTrackedRef.current.add(projectId)
    track('add_repo_existing_workspaces_detected', existingWorkspaceTelemetry)
  }, [existingWorkspaceTelemetry, isSetupStep, projectId])

  const trackSetupAction = useCallback(
    (action: AddRepoSetupStepAction): void => {
      track('add_repo_setup_step_action', {
        action,
        ...(existingWorkspaceTelemetry
          ? {
              source: existingWorkspaceTelemetry.source,
              existing_workspace_count: existingWorkspaceTelemetry.existing_workspace_count,
              existing_linked_workspace_count:
                existingWorkspaceTelemetry.existing_linked_workspace_count
            }
          : {})
      })
    },
    [existingWorkspaceTelemetry]
  )

  const handleCreateWorktree = useCallback(
    (name?: string): void => {
      trackSetupAction('create_worktree')
      // Why: let the dialog close animation finish before the composer takes focus.
      closeModal()
      setTimeout(() => {
        openModal('new-workspace-composer', {
          initialRepoId: projectId,
          ...(name ? { prefilledName: name } : {}),
          telemetrySource: 'sidebar'
        })
      }, 150)
    },
    [closeModal, openModal, projectId, trackSetupAction]
  )

  const handleStartPrimaryWorktree = useCallback((): void => {
    if (!primaryWorktree) {
      return
    }
    trackSetupAction('open_primary')
    closeModal()
    if (useAppStore.getState().hideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    activateAndRevealWorktree(primaryWorktree.id)
  }, [closeModal, primaryWorktree, setHideDefaultBranchWorkspace, trackSetupAction])

  const handleConfigureRepo = useCallback((): void => {
    trackSetupAction('configure')
    closeModal()
    openSettingsTarget({ pane: 'repo', repoId: projectId })
    openSettingsPage()
  }, [closeModal, openSettingsTarget, openSettingsPage, projectId, trackSetupAction])

  const finishImportedRepoWithoutOpening = useCallback(async (): Promise<void> => {
    const importedRepoId = projectId
    closeModal()
    resetState()
    if (!importedRepoId) {
      return
    }
    await fetchWorktrees(importedRepoId)
    const state = useAppStore.getState()
    finalizeImportedRepoAfterSkip(state, importedRepoId)
  }, [closeModal, fetchWorktrees, projectId, resetState])

  const handleUseExistingWorktrees = useCallback(async (): Promise<void> => {
    if (!projectId) {
      return
    }
    const gen = ++setupActionGenRef.current
    trackSetupAction('open_existing')
    if (!otherWorktreesVisible) {
      const updated = await updateRepo(projectId, { externalWorktreeVisibility: 'show' })
      if (gen !== setupActionGenRef.current) {
        return
      }
      if (updated && addedRepo) {
        setAddedRepo({ ...addedRepo, externalWorktreeVisibility: 'show' })
      }
      await fetchWorktrees(projectId)
      if (gen !== setupActionGenRef.current) {
        return
      }
    }
    await finishImportedRepoWithoutOpening()
  }, [
    addedRepo,
    fetchWorktrees,
    finishImportedRepoWithoutOpening,
    otherWorktreesVisible,
    projectId,
    setupActionGenRef,
    setAddedRepo,
    trackSetupAction,
    updateRepo
  ])

  return {
    hiddenWorktreeCount,
    primaryBranchName,
    trackSetupAction,
    finishImportedRepoWithoutOpening,
    handleCreateWorktree,
    handleStartPrimaryWorktree,
    handleConfigureRepo,
    handleUseExistingWorktrees
  }
}
