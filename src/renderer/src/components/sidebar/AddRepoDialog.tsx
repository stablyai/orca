import React, { useCallback, useMemo, useState } from 'react'
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
import { routeAddRepoBrowse } from './add-repo-browse-authority'
import { readDroppedHostPath } from './add-repo-wsl-host-folder-picker'
import { useAddRepoWslHostPaths } from './use-add-repo-wsl-host-paths'

export default React.memo(function AddRepoDialog({
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
  const droppedHostPathData = useAppStore((s) => (hosted ? undefined : s.modalData.droppedHostPath))
  const droppedHostPath = useMemo(
    () => readDroppedHostPath({ droppedHostPath: droppedHostPathData }),
    [droppedHostPathData]
  )
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const scanNestedRepos = useAppStore((s) => s.scanNestedRepos)
  const cancelNestedRepoScan = useAppStore((s) => s.cancelNestedRepoScan)
  const importNestedRepos = useAppStore((s) => s.importNestedRepos)
  const repos = useAppStore((s) => s.repos)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const settings = useAppStore((s) => s.settings)
  const { closeModal, closeForFolderHandoff, finishProjectAdd } = useAddRepoHostedController(hosted)
  const [step, setStep] = useState<AddRepoDialogStep>('add')
  const [isAdding, setIsAdding] = useState(false)
  const [addProjectBusyLabel, setAddProjectBusyLabel] = useState<string | null>(null)
  const completeGitRepoAdd = useCompleteGitRepoAdd({
    closeModal,
    setHideDefaultBranchWorkspace,
    finishProjectAdd
  })
  const hostSelection = useAddRepoHostSelection({
    isOpen,
    setStep,
    preferredHostId: droppedHostPath?.hostId ?? null
  })
  const selectedRuntimeEnvironmentId =
    hostSelection.selectedParsedHost?.kind === 'runtime'
      ? hostSelection.selectedParsedHost.environmentId
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
    setSelectedTargetId,
    setRemotePath,
    setRemoteError,
    resetRemoteState,
    handleOpenRemoteStep,
    handleAddRemoteRepo,
    handleConnectTarget
  } = useRemoteRepo(
    fetchWorktrees,
    setStep,
    // Why: useRemoteRepo closes only for the non-git → confirm-dialog handoff.
    closeForFolderHandoff,
    (repoId, executionHostId) => completeGitRepoAdd(repoId, 'ssh_remote_path', executionHostId),
    selectedRuntimeEnvironmentId
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
      hostId: hostSelection.selectedHostId,
      runtimeEnvironmentId: selectedRuntimeEnvironmentId
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
    hostId: hostSelection.selectedHostId,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
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
    resetLocalFolderFlow()
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
    resetLocalFolderFlow,
    resetServerPathFlow
  ])

  useAddRepoHostChangeReset({
    isOpen,
    selectedHostId: hostSelection.selectedHostId,
    onResetClosed: resetState,
    onResetHostScopedState: resetHostScopedState
  })

  // Why after the host-change reset: a drop's path must survive the reset its host switch causes.
  const { browseWslHost, prefilledServerPath, clearPrefilledServerPath } = useAddRepoWslHostPaths({
    isOpen,
    droppedHostPath,
    selectedHostId: hostSelection.selectedHostId,
    setServerPath,
    setStep
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
      isCloning={isCloning}
      onBack={handleBack}
      onCloseAutoFocus={hosted?.onCloseAutoFocus}
      onOpenChange={handleOpenChange}
    >
      <AddRepoDialogStepContent
        step={step}
        isRuntimeEnvironmentActive={isRuntimeEnvironmentActive}
        activeRuntimeEnvironmentId={selectedRuntimeEnvironmentId}
        repoCount={repos.length}
        isAdding={isAdding}
        addProjectBusyLabel={addProjectBusyLabel}
        nestedScanInProgress={nestedScanInProgress}
        nestedScanId={nestedScanId}
        serverPath={serverPath}
        serverPathPrefilled={prefilledServerPath !== null && prefilledServerPath === serverPath}
        isAddingServerPath={isAddingServerPath}
        cloneUrl={cloneUrl}
        cloneDestination={cloneDestination}
        cloneError={cloneError}
        cloneProgress={cloneProgress}
        isCloning={isCloning}
        sshTargets={sshTargets}
        selectedTargetId={selectedTargetId}
        selectedHostLabel={
          hostSelection.hostOptions.find((host) => host.id === hostSelection.selectedHostId)
            ?.label ?? null
        }
        remotePath={remotePath}
        remoteError={remoteError}
        isAddingRemote={isAddingRemote}
        nestedScan={nestedScan}
        nestedSelectedPaths={nestedSelectedPaths}
        nestedGroupName={nestedGroupName}
        createName={createName}
        createParent={createParent}
        createError={createError}
        isCreating={isCreating}
        hostSelector={<AddRepoHostSelectorSlot hostSelection={hostSelection} />}
        actionsDisabled={!hostSelection.selectedHostId}
        browseHostKind={selectedHostKind === 'local' ? 'local' : 'runtime'}
        createDefaultParent={createDefaultParent}
        createGitAvailability={createGitAvailability}
        createRuntimeParentStatus={createRuntimeParentStatus}
        createParentDefaultPending={createParentDefaultPending}
        manualCreateParentEntry={isRuntimeEnvironmentActive}
        onBrowse={() =>
          routeAddRepoBrowse(hostSelection.selectedParsedHost, {
            browseLocal: () => void handleBrowse(),
            browseRuntime: () => {
              clearPrefilledServerPath()
              setStep('server-path')
            },
            browseWslHost
          })
        }
        onOpenCloneStep={() => {
          if (!hostSelection.selectedHostId) {
            return
          }
          setCloneError(null)
          setStep('clone')
        }}
        onOpenCreateStep={() => {
          if (!hostSelection.selectedHostId) {
            return
          }
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
        onConnectTarget={handleConnectTarget}
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
