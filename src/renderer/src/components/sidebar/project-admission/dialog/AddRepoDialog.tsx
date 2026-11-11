import React, { useCallback, useState } from 'react'
import { useAppStore } from '@/store/index'
import { useRemoteRepo } from './AddRepoSteps'
import { useCreateRepo } from '../create/useCreateRepo'
import { AddRepoDialogStepContent } from './AddRepoDialogStepContent'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useAddRepoCloneFlow } from './useAddRepoCloneFlow'
import { useAddRepoLocalFolderFlow } from './useAddRepoLocalFolderFlow'
import { useAddRepoServerPathFlow } from './useAddRepoServerPathFlow'
import { useAddRepoHostSelection } from '../host-selection/use-add-repo-host-selection'
import { useCompleteGitRepoAdd } from '../completion/use-complete-git-repo-add'
import { useCreateProjectDefaults } from '../create/useCreateProjectDefaults'
import { useAddRepoHostChangeReset } from '../host-selection/use-add-repo-host-change-reset'
import { AddRepoDialogChrome } from './AddRepoDialogChrome'
import { AddRepoHostSelectorSlot } from '../host-selection/AddRepoHostSelectorSlot'
import { useAddRepoNestedReviewController } from '../nested-import/useAddRepoNestedReviewController'
import {
  useAddRepoHostedController,
  type AddRepoDialogProps
} from '../host-selection/use-add-repo-hosted-controller'
import { routeAddRepoBrowse } from './add-repo-browse-authority'
import { useAddRepoWslHostPaths } from '../host-selection/use-add-repo-wsl-host-paths'
import { useAddRepoDialogModalPaths } from './use-add-repo-dialog-modal-paths'
import { useAddRepoWindowsDriveRefusal } from '../host-selection/use-add-repo-windows-drive-refusal'
import { useAddRepoWslHostOffer } from '../host-selection/use-add-repo-wsl-host-offer'

export default React.memo(function AddRepoDialog({ hosted }: AddRepoDialogProps) {
  const isOpen = useAppStore((s) => (hosted ? hosted.open : s.activeModal === 'add-repo'))
  const modalPaths = useAddRepoDialogModalPaths(Boolean(hosted))
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const addNonGitFolder = useAppStore((s) => s.addNonGitFolder)
  const openModal = useAppStore((s) => s.openModal)
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
    preferredHostId: modalPaths.preferredHostId
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
    // Only the non-git confirmation handoff closes this remote flow.
    closeForFolderHandoff,
    (repoId, executionHostId) => completeGitRepoAdd(repoId, 'ssh_remote_path', executionHostId),
    selectedRuntimeEnvironmentId
  )

  const {
    createName,
    createParent,
    createKind,
    createError,
    isCreating,
    setCreateName,
    setCreateParent,
    setCreateKind,
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
      runtimeEnvironmentId: selectedRuntimeEnvironmentId,
      onWindowsDriveRefusal: (refusal) => windowsDrive.showRefusal(refusal, 'create')
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
    cloneFolder,
    cloneProgress,
    isCloning,
    changeCloneUrl,
    changeCloneDestination,
    changeCloneFolderName,
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
  const wslHostOffer = useAddRepoWslHostOffer(isOpen, hostSelection, modalPaths.droppedHostPath)
  const { handleBrowse, resetLocalFolderFlow, handleAddLocalPath } = useAddRepoLocalFolderFlow({
    isOpen,
    droppedLocalPath: modalPaths.droppedLocalPath,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    addRepoPath,
    openModal,
    closeModal: closeForFolderHandoff,
    fetchWorktrees,
    scanNestedRepos,
    setActiveNestedScanId,
    setNestedScanInProgress,
    showNestedRepoReview,
    onGitRepoReady: completeGitRepoAdd,
    setIsAdding,
    setAddProjectBusyLabel,
    offerWslHost: wslHostOffer.offer
  })
  const {
    serverPath,
    isAddingServerPath,
    setServerPath,
    resetServerPathFlow,
    handleAddServerPath
  } = useAddRepoServerPathFlow({
    addRepoPath,
    addNonGitFolder,
    activeRuntimeEnvironmentId: selectedRuntimeEnvironmentId,
    closeModal: closeForFolderHandoff,
    fetchWorktrees,
    getNestedRepoRuntimeKind,
    scanNestedRepos,
    setActiveNestedScanId,
    setNestedScanInProgress,
    showNestedRepoReview,
    onGitRepoReady: completeGitRepoAdd,
    setAddProjectBusyLabel,
    onWindowsDriveRefusal: (refusal) => windowsDrive.showRefusal(refusal)
  })

  const resetState = useCallback(() => {
    // Closing/backing out must abort an active clone instead of leaving it running on disk.
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

  const windowsDrive = useAddRepoWindowsDriveRefusal({
    isOpen,
    selectedHostId: hostSelection.selectedHostId,
    selectHost: hostSelection.handleSelectAddProjectHost,
    addLocalPath: handleAddLocalPath,
    createStep: { setStep, setCreateParent }
  })
  // Apply dropped paths after host reset so the switch cannot erase them.
  const { browseWslHost, prefilledServerPath, clearPrefilledServerPath } = useAddRepoWslHostPaths({
    isOpen,
    droppedHostPath: wslHostOffer.hostPath,
    selectedHostId: hostSelection.selectedHostId,
    setServerPath,
    setStep,
    onWindowsDriveRefusal: windowsDrive.showRefusal
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
        cloneFolder={cloneFolder}
        cloneProgress={cloneProgress}
        isCloning={isCloning}
        sshTargets={sshTargets}
        selectedTargetId={selectedTargetId}
        selectedHostLabel={hostSelection.selectedHostLabel}
        remotePath={remotePath}
        remoteError={remoteError}
        isAddingRemote={isAddingRemote}
        nestedScan={nestedScan}
        nestedSelectedPaths={nestedSelectedPaths}
        nestedGroupName={nestedGroupName}
        createName={createName}
        createParent={createParent}
        createKind={createKind}
        createError={createError}
        isCreating={isCreating}
        hostSelector={<AddRepoHostSelectorSlot hostSelection={hostSelection} />}
        windowsDriveNotice={windowsDrive.notice ?? wslHostOffer.notice(handleAddLocalPath)}
        actionsDisabled={!hostSelection.selectedHostId}
        browseHostKind={hostSelection.selectedParsedHost?.kind === 'local' ? 'local' : 'runtime'}
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
        onCloneUrlChange={changeCloneUrl}
        onCloneDestinationChange={changeCloneDestination}
        onCloneFolderNameChange={changeCloneFolderName}
        onPickCloneDestination={handlePickDestination}
        onClone={handleClone}
        onNestedGroupNameChange={setNestedGroupName}
        onNestedSelectedPathsChange={setNestedSelectedPaths}
        onImportNestedRepos={(mode) => void handleImportNestedRepos(mode)}
        onOpenNestedRootFolder={() => void handleOpenNestedRootFolder()}
        onCreateNameChange={setCreateName}
        onCreateParentChange={(value) => {
          markCreateParentTouched(value)
          setCreateParent(value)
          setCreateError(null)
        }}
        onCreateKindChange={setCreateKind}
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
