import React, { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { useRemoteRepo } from './AddRepoSteps'
import { useCreateRepo } from './useCreateRepo'
import { AddRepoDialogStepContent } from './AddRepoDialogStepContent'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useAddRepoNestedReviewState } from './useAddRepoNestedReviewState'
import { useAddRepoCloneFlow } from './useAddRepoCloneFlow'
import { useAddRepoLocalFolderFlow } from './useAddRepoLocalFolderFlow'
import { useAddRepoServerPathFlow } from './useAddRepoServerPathFlow'
import { useAddRepoNestedImportFlow } from './useAddRepoNestedImportFlow'
import { useAddRepoHostSelection } from './use-add-repo-host-selection'
import { useCompleteGitRepoAdd } from './use-complete-git-repo-add'
import { useCreateProjectDefaults } from './useCreateProjectDefaults'
import { useAddRepoHostChangeReset } from './use-add-repo-host-change-reset'
import { AddRepoDialogChrome } from './AddRepoDialogChrome'
import { AddRepoHostSelectorSlot } from './AddRepoHostSelectorSlot'
import { useAddRepoRemoteNestedScan } from './use-add-repo-remote-nested-scan'
import {
  useAddRepoHostedController,
  type AddRepoDialogHostedController
} from './use-add-repo-hosted-controller'

const AddRepoDialog = React.memo(function AddRepoDialog({
  hosted
}: {
  hosted?: AddRepoDialogHostedController
}) {
  const isOpen = useAppStore((s) => (hosted ? hosted.open : s.activeModal === 'add-repo'))
  // Why: hosted mode never receives dropped paths through modalData — that
  // channel belongs to the store-modal instance.
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
  const completeGitRepoAdd = useCompleteGitRepoAdd({
    closeModal,
    setHideDefaultBranchWorkspace,
    finishProjectAdd
  })

  const [step, setStep] = useState<AddRepoDialogStep>('add')
  const [isAdding, setIsAdding] = useState(false)
  const [addProjectBusyLabel, setAddProjectBusyLabel] = useState<string | null>(null)
  const {
    nestedScan,
    nestedSelectedPaths,
    nestedGroupName,
    nestedConnectionId,
    nestedAttemptId,
    nestedRuntimeKind,
    nestedScanInProgress,
    nestedScanId,
    nestedImportScanId,
    setNestedSelectedPaths,
    setNestedGroupName,
    setNestedScanInProgress,
    getNestedRepoRuntimeKind,
    showNestedRepoReview,
    setActiveNestedScanId,
    handleStopNestedScan,
    resetNestedRepoReviewState
  } = useAddRepoNestedReviewState({
    activeRuntimeEnvironmentId: settings?.activeRuntimeEnvironmentId,
    cancelNestedRepoScan,
    setStep
  })

  const hostSelection = useAddRepoHostSelection({ isOpen, setStep })
  const selectedRuntimeEnvironmentId =
    hostSelection.selectedParsedHost?.kind === 'runtime'
      ? hostSelection.selectedParsedHost.environmentId
      : null
  const { showRemoteNestedRepoReview, trackRemoteNestedScanResult } = useAddRepoRemoteNestedScan({
    setActiveNestedScanId,
    showNestedRepoReview
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
    (repoId) => completeGitRepoAdd(repoId, 'ssh_remote_path'),
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
    // Why: useCreateRepo closes only after a folder (non-git) create.
    closeForFolderHandoff,
    (repoId) => completeGitRepoAdd(repoId, 'create_project'),
    {
      hostId: hostSelection.selectedHostId,
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
  const selectedHostKind = hostSelection.selectedParsedHost?.kind
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
  const {
    handleImportNestedRepos,
    handleOpenNestedRootFolder,
    resetNestedImportFlow,
    trackNestedBackAction
  } = useAddRepoNestedImportFlow({
    nestedAttemptId,
    nestedScan,
    nestedSelectedPaths,
    nestedRuntimeKind,
    nestedConnectionId,
    nestedGroupName,
    nestedImportScanId,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    // Why: open-as-folder outcomes navigate; git imports finish via
    // completeGitRepoAdd instead.
    closeModal: closeForFolderHandoff,
    fetchWorktrees,
    importNestedRepos,
    getNestedRepoRuntimeKind,
    onGitRepoReady: completeGitRepoAdd,
    setIsAdding
  })

  const resetState = useCallback(() => {
    // Why: kill the git clone process if one is running, so backing out
    // or closing the dialog doesn't leave a clone running on disk.
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
    setIsAdding(false)
    setAddProjectBusyLabel(null)
    resetServerPathFlow()
    resetCloneFlow()
    resetCreateDefaultState()
    resetCreateState()
    resetRemoteState()
  }, [
    resetCloneFlow,
    resetCreateDefaultState,
    resetCreateState,
    resetRemoteState,
    resetServerPathFlow
  ])

  useAddRepoHostChangeReset({
    isOpen,
    selectedHostId: hostSelection.selectedHostId,
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

  return (
    <AddRepoDialogChrome
      isOpen={isOpen}
      step={step}
      isAdding={isAdding}
      onBack={handleBack}
      onCloseAutoFocus={hosted?.onCloseAutoFocus}
      onOpenChange={handleOpenChange}
    >
      <AddRepoDialogStepContent
        step={step}
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
          hostSelection.hostOptions.find((host) => host.id === hostSelection.selectedHostId)
            ?.label ?? hostSelection.selectedHostId
        }
        lockSshTargetSelection={hostSelection.selectedParsedHost?.kind === 'ssh'}
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
        browseHostKind={
          selectedHostKind === 'ssh' || selectedHostKind === 'runtime' ? selectedHostKind : 'local'
        }
        createDefaultParent={createDefaultParent}
        createGitAvailability={createGitAvailability}
        createRuntimeParentStatus={createRuntimeParentStatus}
        createParentDefaultPending={createParentDefaultPending}
        manualCreateParentEntry={isRuntimeEnvironmentActive || selectedHostKind === 'ssh'}
        onBrowse={
          selectedHostKind === 'ssh'
            ? () => void handleOpenRemoteStep(hostSelection.selectedSshTargetId)
            : selectedHostKind === 'runtime'
              ? () => setStep('server-path')
              : handleBrowse
        }
        onOpenCloneStep={() => {
          setCloneError(null)
          setStep('clone')
        }}
        onOpenCreateStep={() => {
          setCreateError(null)
          setStep('create')
        }}
        onOpenRemoteStep={handleOpenRemoteStep}
        onStopNestedScan={handleStopNestedScan}
        onServerPathChange={setServerPath}
        onAddServerPath={(kind) => void handleAddServerPath(kind)}
        onSelectTarget={(id) => {
          setSelectedTargetId(id)
          setRemoteError(null)
        }}
        onRemotePathChange={(value) => {
          setRemotePath(value)
          setRemoteError(null)
        }}
        onAddRemoteRepo={handleAddRemoteRepo}
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
        onClone={handleClone}
        onNestedGroupNameChange={setNestedGroupName}
        onNestedSelectedPathsChange={setNestedSelectedPaths}
        onImportNestedRepos={(mode) => void handleImportNestedRepos(mode)}
        onOpenNestedRootFolder={() => void handleOpenNestedRootFolder()}
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
        onCreate={handleCreate}
      />
    </AddRepoDialogChrome>
  )
})

export default AddRepoDialog
