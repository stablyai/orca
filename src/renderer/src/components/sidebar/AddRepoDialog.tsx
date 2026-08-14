import React, { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { useRemoteRepo } from './AddRepoSteps'
import { useCreateRepo } from './useCreateRepo'
import { AddRepoDialogStepContent } from './AddRepoDialogStepContent'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useAddRepoCloneFlow } from './useAddRepoCloneFlow'
import { useAddRepoLocalFolderFlow } from './useAddRepoLocalFolderFlow'
import { useAddRepoServerPathFlow } from './useAddRepoServerPathFlow'
import { useAddRepoHostSelection } from './use-add-repo-host-selection'
import { useCompleteGitRepoAdd } from './use-complete-git-repo-add'
import { useCreateProjectDefaults } from './useCreateProjectDefaults'
import { useAddRepoHostChangeReset } from './use-add-repo-host-change-reset'
import { AddRepoDialogChrome } from './AddRepoDialogChrome'
import { AddRepoHostSelectorSlot } from './AddRepoHostSelectorSlot'
import { useAddRepoNestedReviewController } from './useAddRepoNestedReviewController'
import {
  useAddRepoHostedController,
  type AddRepoDialogHostedController
} from './use-add-repo-hosted-controller'
import { routeAddRepoBrowse, runAddRepoHostAction } from './add-repo-browse-authority'

export default React.memo(function AddRepoDialog({
  hosted
}: {
  hosted?: AddRepoDialogHostedController
}) {
  const isOpen = useAppStore((s) => (hosted ? hosted.open : s.activeModal === 'add-repo'))
  // Why: modalData belongs to the store-modal instance, not hosted mode.
  const droppedLocalPath = useAppStore((s) =>
    !hosted && typeof s.modalData.droppedLocalPath === 'string' ? s.modalData.droppedLocalPath : ''
  )
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const scanNestedRepos = useAppStore((s) => s.scanNestedRepos)
  const cancelNestedRepoScan = useAppStore((s) => s.cancelNestedRepoScan)
  const importNestedRepos = useAppStore((s) => s.importNestedRepos)
  const repos = useAppStore((s) => s.repos)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const settings = useAppStore((s) => s.settings)
  const { closeModal, closeForFolderHandoff, finishProjectAdd, handleOpenSshSettings } =
    useAddRepoHostedController(hosted)
  const [step, setStep] = useState<AddRepoDialogStep>('add')
  const [isAdding, setIsAdding] = useState(false)
  const [addProjectBusyLabel, setAddProjectBusyLabel] = useState<string | null>(null)
  const completeGitRepoAdd = useCompleteGitRepoAdd({
    closeModal,
    setHideDefaultBranchWorkspace,
    finishProjectAdd
  })
  const hostSelection = useAddRepoHostSelection({ isOpen, setStep })
  const effectiveStep = hostSelection.actionableHostId || step === 'add' ? step : 'add'
  const selectedRuntimeEnvironmentId =
    hostSelection.actionableParsedHost?.kind === 'runtime'
      ? hostSelection.actionableParsedHost.environmentId
      : null
  const {
    nestedScan,
    nestedSelectedPaths,
    nestedGroupName,
    nestedScanInProgress,
    nestedScanId,
    setNestedSelectedPaths,
    setNestedGroupName,
    setNestedScanInProgress,
    getNestedRepoRuntimeKind,
    showNestedRepoReview,
    setActiveNestedScanId,
    handleStopNestedScan,
    resetNestedRepoReviewState,
    showRemoteNestedRepoReview,
    trackRemoteNestedScanResult,
    handleImportNestedRepos,
    handleOpenNestedRootFolder,
    resetNestedImportFlow,
    trackNestedBackAction
  } = useAddRepoNestedReviewController({
    reviewRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    cancelNestedRepoScan,
    closeModal: closeForFolderHandoff,
    fetchWorktrees,
    importNestedRepos,
    onGitRepoReady: completeGitRepoAdd,
    setIsAdding,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    setStep
  })
  const {
    sshTargets,
    selectedTargetId,
    remotePath,
    remoteError,
    isAddingRemote,
    isScanningNested: isScanningRemoteNested,
    setSelectedTargetId,
    setRemotePath,
    setRemoteError,
    resetRemoteState,
    handleOpenRemoteStep,
    handleAddRemoteRepo,
    handleConnectTarget,
    stopRemoteNestedScan
  } = useRemoteRepo(
    fetchWorktrees,
    setStep,
    // Why: useRemoteRepo closes only for the non-git → confirm-dialog handoff.
    closeForFolderHandoff,
    (repoId, executionHostId) => completeGitRepoAdd(repoId, 'ssh_remote_path', executionHostId),
    scanNestedRepos,
    showRemoteNestedRepoReview,
    trackRemoteNestedScanResult
  )
  const {
    createName,
    createParent,
    createError,
    isCreating,
    setCreateName,
    setCreateParent,
    setCreateError,
    resetCreateState,
    handlePickParent,
    handleCreate
  } = useCreateRepo(
    fetchWorktrees,
    closeForFolderHandoff,
    (repoId, executionHostId) => completeGitRepoAdd(repoId, 'create_project', executionHostId),
    {
      hostId: hostSelection.actionableHostId,
      runtimeEnvironmentId: selectedRuntimeEnvironmentId,
      sshTargetId: hostSelection.selectedSshTargetId
    }
  )

  const {
    createDefaultParent,
    createGitAvailability,
    createRuntimeParentStatus,
    createParentDefaultPending,
    resetCreateDefaultState,
    markCreateParentTouched
  } = useCreateProjectDefaults({
    step,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    sshTargetId: hostSelection.selectedSshTargetId,
    createParent,
    setCreateParent
  })

  const {
    cloneUrl,
    cloneDestination,
    cloneError,
    cloneProgress,
    isCloning,
    setCloneUrl,
    setCloneDestination,
    setCloneError,
    resetCloneFlow,
    handlePickDestination,
    handleClone
  } = useAddRepoCloneFlow({
    step,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    sshTargetId: hostSelection.selectedSshTargetId,
    workspaceDir: settings?.workspaceDir,
    fetchWorktrees,
    onGitRepoReady: completeGitRepoAdd
  })

  const isRuntimeEnvironmentActive = Boolean(selectedRuntimeEnvironmentId)
  const selectedHostKind = hostSelection.actionableParsedHost?.kind
  const { handleBrowse, resetLocalFolderFlow } = useAddRepoLocalFolderFlow({
    isOpen,
    droppedLocalPath,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    addRepoPath,
    // Why: this flow's closes are all folder/non-git outcomes that navigate.
    closeModal: closeForFolderHandoff,
    fetchWorktrees,
    scanNestedRepos,
    setActiveNestedScanId,
    setNestedScanInProgress,
    showNestedRepoReview,
    onGitRepoReady: completeGitRepoAdd,
    setIsAdding,
    setAddProjectBusyLabel
  })
  const {
    serverPath,
    isAddingServerPath,
    setServerPath,
    resetServerPathFlow,
    handleAddServerPath
  } = useAddRepoServerPathFlow({
    addRepoPath,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    // Why: closes only after a folder add, which activates the folder workspace.
    closeModal: closeForFolderHandoff,
    fetchWorktrees,
    getNestedRepoRuntimeKind,
    scanNestedRepos,
    setActiveNestedScanId,
    setNestedScanInProgress,
    showNestedRepoReview,
    onGitRepoReady: completeGitRepoAdd,
    setAddProjectBusyLabel
  })

  const resetState = useCallback(() => {
    // Why: backing out must not leave a clone running on disk.
    void window.api.repos.cloneAbort()
    resetLocalFolderFlow()
    setStep('add')
    setIsAdding(false)
    setAddProjectBusyLabel(null)
    resetServerPathFlow()
    resetCloneFlow()
    resetNestedImportFlow()
    resetNestedRepoReviewState()
    resetCreateDefaultState()
    resetCreateState()
    resetRemoteState()
  }, [
    resetCloneFlow,
    resetLocalFolderFlow,
    resetNestedRepoReviewState,
    resetCreateDefaultState,
    resetServerPathFlow,
    resetNestedImportFlow,
    resetRemoteState,
    resetCreateState
  ])

  const resetHostScopedState = useCallback(() => {
    setStep('add')
    setIsAdding(false)
    setAddProjectBusyLabel(null)
    resetLocalFolderFlow()
    resetServerPathFlow()
    resetCloneFlow()
    resetNestedImportFlow()
    resetNestedRepoReviewState()
    resetCreateDefaultState()
    resetCreateState()
    resetRemoteState()
  }, [
    resetCloneFlow,
    resetCreateDefaultState,
    resetCreateState,
    resetNestedImportFlow,
    resetNestedRepoReviewState,
    resetRemoteState,
    resetLocalFolderFlow,
    resetServerPathFlow
  ])

  useAddRepoHostChangeReset({
    isOpen,
    selectedHostId: hostSelection.actionableHostId,
    onResetClosed: resetState,
    onResetHostScopedState: resetHostScopedState
  })

  const handleBack = useCallback(() => {
    if (step === 'nested') {
      trackNestedBackAction()
    }
    resetState()
  }, [resetState, step, trackNestedBackAction])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        if (step === 'nested' && !isAdding) {
          trackNestedBackAction()
        }
        closeModal()
        resetState()
      }
    },
    [closeModal, isAdding, resetState, step, trackNestedBackAction]
  )
  const runAddRepoMutation = useCallback(
    (mutation: () => void): void => runAddRepoHostAction(hostSelection.actionableHostId, mutation),
    [hostSelection.actionableHostId]
  )

  return (
    <AddRepoDialogChrome
      isOpen={isOpen}
      step={effectiveStep}
      isAdding={isAdding}
      onBack={handleBack}
      onCloseAutoFocus={hosted?.onCloseAutoFocus}
      onOpenChange={handleOpenChange}
    >
      <AddRepoDialogStepContent
        step={effectiveStep}
        isRuntimeEnvironmentActive={isRuntimeEnvironmentActive}
        activeRuntimeEnvironmentId={selectedRuntimeEnvironmentId}
        isSshLikely={false}
        repoCount={repos.length}
        isAdding={isAdding}
        addProjectBusyLabel={addProjectBusyLabel}
        nestedScanInProgress={nestedScanInProgress}
        nestedScanId={nestedScanId}
        serverPath={serverPath}
        isAddingServerPath={isAddingServerPath}
        cloneUrl={cloneUrl}
        cloneDestination={cloneDestination}
        cloneError={cloneError}
        cloneProgress={cloneProgress}
        isCloning={isCloning}
        sshTargets={sshTargets}
        selectedTargetId={selectedTargetId}
        selectedSshTargetId={hostSelection.selectedSshTargetId}
        selectedHostLabel={
          hostSelection.hostOptions.find((host) => host.id === hostSelection.actionableHostId)
            ?.label ?? null
        }
        lockSshTargetSelection={hostSelection.actionableParsedHost?.kind === 'ssh'}
        remotePath={remotePath}
        remoteError={remoteError}
        isAddingRemote={isAddingRemote}
        isScanningRemoteNested={isScanningRemoteNested}
        nestedScan={nestedScan}
        nestedSelectedPaths={nestedSelectedPaths}
        nestedGroupName={nestedGroupName}
        createName={createName}
        createParent={createParent}
        createError={createError}
        isCreating={isCreating}
        hostSelector={<AddRepoHostSelectorSlot hostSelection={hostSelection} />}
        showRemoteAction={false}
        actionsDisabled={!hostSelection.actionableHostId}
        browseHostKind={selectedHostKind ?? 'runtime'}
        createDefaultParent={createDefaultParent}
        createGitAvailability={createGitAvailability}
        createRuntimeParentStatus={createRuntimeParentStatus}
        createParentDefaultPending={createParentDefaultPending}
        manualCreateParentEntry={isRuntimeEnvironmentActive || selectedHostKind === 'ssh'}
        onBrowse={() =>
          runAddRepoMutation(() =>
            routeAddRepoBrowse(hostSelection.actionableParsedHost, {
              browseLocal: () => void handleBrowse(),
              browseRuntime: () => setStep('server-path'),
              browseSsh: (targetId) => void handleOpenRemoteStep(targetId)
            })
          )
        }
        onOpenCloneStep={() =>
          runAddRepoMutation(() => {
            setCloneError(null)
            setStep('clone')
          })
        }
        onOpenCreateStep={() =>
          runAddRepoMutation(() => {
            setCreateError(null)
            setStep('create')
          })
        }
        onOpenRemoteStep={handleOpenRemoteStep}
        onStopNestedScan={handleStopNestedScan}
        onServerPathChange={setServerPath}
        onAddServerPath={(kind) => runAddRepoMutation(() => void handleAddServerPath(kind))}
        onSelectTarget={(id) => {
          setSelectedTargetId(id)
          setRemoteError(null)
        }}
        onRemotePathChange={(value) => {
          setRemotePath(value)
          setRemoteError(null)
        }}
        onAddRemoteRepo={() => runAddRepoMutation(() => void handleAddRemoteRepo())}
        onOpenSshSettings={handleOpenSshSettings}
        onConnectTarget={handleConnectTarget}
        onStopRemoteNestedScan={stopRemoteNestedScan}
        onCloneUrlChange={(value) => {
          setCloneUrl(value)
          setCloneError(null)
        }}
        onCloneDestinationChange={(value) => {
          setCloneDestination(value)
          setCloneError(null)
        }}
        onPickCloneDestination={handlePickDestination}
        onClone={() => runAddRepoMutation(() => void handleClone())}
        onNestedGroupNameChange={setNestedGroupName}
        onNestedSelectedPathsChange={setNestedSelectedPaths}
        onImportNestedRepos={(mode) => runAddRepoMutation(() => void handleImportNestedRepos(mode))}
        onOpenNestedRootFolder={() => runAddRepoMutation(() => void handleOpenNestedRootFolder())}
        onCreateNameChange={(value) => {
          setCreateName(value)
          setCreateError(null)
        }}
        onCreateParentChange={(value) => {
          markCreateParentTouched(value)
          setCreateParent(value)
          setCreateError(null)
        }}
        onPickCreateParent={() => {
          void handlePickParent().then((dir) => {
            if (dir) {
              markCreateParentTouched(dir)
            }
          })
        }}
        onCreate={() => runAddRepoMutation(() => void handleCreate())}
      />
    </AddRepoDialogChrome>
  )
})
