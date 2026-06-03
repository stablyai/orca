import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { track } from '@/lib/telemetry'
import { useRemoteRepo } from './AddRepoSteps'
import { useCreateRepo } from './AddRepoCreateStep'
import { buildNestedRepoScanTelemetry } from '../../../../shared/nested-repo-telemetry'
import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { Repo } from '../../../../shared/types'
import { AddRepoStepIndicator } from './AddRepoStepIndicator'
import { AddRepoDialogStepContent } from './AddRepoDialogStepContent'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useAddRepoNestedReviewState } from './useAddRepoNestedReviewState'
import { useAddRepoCloneFlow } from './useAddRepoCloneFlow'
import { useAddRepoLocalFolderFlow } from './useAddRepoLocalFolderFlow'
import { useAddRepoServerPathFlow } from './useAddRepoServerPathFlow'
import { useAddRepoNestedImportFlow } from './useAddRepoNestedImportFlow'
import { useAddRepoSetupActions } from './useAddRepoSetupActions'

const AddRepoDialog = React.memo(function AddRepoDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const scanNestedRepos = useAppStore((s) => s.scanNestedRepos)
  const cancelNestedRepoScan = useAppStore((s) => s.cancelNestedRepoScan)
  const importNestedRepos = useAppStore((s) => s.importNestedRepos)
  const repos = useAppStore((s) => s.repos)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const settings = useAppStore((s) => s.settings)

  const [step, setStep] = useState<AddRepoDialogStep>('add')
  const [addedRepo, setAddedRepo] = useState<Repo | null>(null)
  const [existingWorkspaceSource, setExistingWorkspaceSource] =
    useState<AddRepoExistingWorkspaceSource | null>(null)
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

  // Why: setup actions can await settings/worktree refreshes; resetState
  // cancels stale continuations when the setup step is dismissed.
  const setupActionGenRef = useRef(0)

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
    setAddedRepo,
    closeModal,
    setExistingWorkspaceSource,
    scanNestedRepos,
    (scan, selectedPath, connectionId, attemptId, inProgress, scanId) => {
      setActiveNestedScanId(inProgress ? scanId : null)
      showNestedRepoReview({
        scan,
        selectedPath,
        connectionId,
        attemptId,
        runtimeKind: 'ssh',
        inProgress,
        scanId
      })
    },
    (scan, attemptId) => {
      track(
        'add_repo_nested_scan_result',
        buildNestedRepoScanTelemetry({
          attemptId,
          surface: 'sidebar',
          runtimeKind: 'ssh',
          scan
        })
      )
    }
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
  } = useCreateRepo(fetchWorktrees, setStep, setAddedRepo, closeModal, setExistingWorkspaceSource)

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
    activeRuntimeEnvironmentId: settings?.activeRuntimeEnvironmentId,
    workspaceDir: settings?.workspaceDir,
    fetchWorktrees,
    setStep,
    setAddedRepo,
    setExistingWorkspaceSource
  })

  const isOpen = activeModal === 'add-repo'
  const droppedLocalPath =
    typeof modalData.droppedLocalPath === 'string' ? modalData.droppedLocalPath : ''
  const projectId = addedRepo?.id ?? ''
  const isRuntimeEnvironmentActive = Boolean(settings?.activeRuntimeEnvironmentId?.trim())

  const { handleBrowse, resetLocalFolderFlow } = useAddRepoLocalFolderFlow({
    isOpen,
    droppedLocalPath,
    activeRuntimeEnvironmentId: settings?.activeRuntimeEnvironmentId,
    addRepoPath,
    closeModal,
    fetchWorktrees,
    scanNestedRepos,
    setActiveNestedScanId,
    setNestedScanInProgress,
    showNestedRepoReview,
    setStep,
    setAddedRepo,
    setExistingWorkspaceSource,
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
    closeModal,
    fetchWorktrees,
    getNestedRepoRuntimeKind,
    scanNestedRepos,
    setActiveNestedScanId,
    setNestedScanInProgress,
    showNestedRepoReview,
    setStep,
    setAddedRepo,
    setExistingWorkspaceSource,
    setAddProjectBusyLabel
  })
  const { handleImportNestedRepos, resetNestedImportFlow, trackNestedBackAction } =
    useAddRepoNestedImportFlow({
      nestedAttemptId,
      nestedScan,
      nestedSelectedPaths,
      nestedRuntimeKind,
      nestedConnectionId,
      nestedGroupName,
      nestedImportScanId,
      activeRuntimeEnvironmentId: settings?.activeRuntimeEnvironmentId,
      fetchWorktrees,
      importNestedRepos,
      getNestedRepoRuntimeKind,
      setAddedRepo,
      setExistingWorkspaceSource,
      setStep,
      setIsAdding
    })

  const resetState = useCallback(() => {
    setupActionGenRef.current++
    // Why: kill the git clone process if one is running, so backing out
    // or closing the dialog doesn't leave a clone running on disk.
    void window.api.repos.cloneAbort()
    resetLocalFolderFlow()
    setStep('add')
    setAddedRepo(null)
    setExistingWorkspaceSource(null)
    setIsAdding(false)
    setAddProjectBusyLabel(null)
    resetServerPathFlow()
    resetCloneFlow()
    resetNestedImportFlow()
    resetNestedRepoReviewState()
    resetCreateState()
    resetRemoteState()
  }, [
    resetCloneFlow,
    resetLocalFolderFlow,
    resetNestedRepoReviewState,
    resetServerPathFlow,
    resetNestedImportFlow,
    resetRemoteState,
    resetCreateState
  ])

  // Why: reset state on close so reopening doesn't show stale step/repo.
  useEffect(() => {
    if (!isOpen) {
      resetState()
    }
  }, [isOpen, resetState])

  const isInputStep =
    step === 'add' ||
    step === 'clone' ||
    step === 'remote' ||
    step === 'create' ||
    step === 'nested'

  const {
    hiddenWorktreeCount,
    primaryBranchName,
    trackSetupAction,
    finishImportedRepoWithoutOpening,
    handleCreateWorktree,
    handleStartPrimaryWorktree,
    handleConfigureRepo,
    handleUseExistingWorktrees
  } = useAddRepoSetupActions({
    addedRepo,
    existingWorkspaceSource,
    isSetupStep: step === 'setup',
    projectId,
    closeModal,
    openModal,
    openSettingsPage,
    openSettingsTarget,
    fetchWorktrees,
    resetState,
    setupActionGenRef,
    setAddedRepo
  })

  // Why: handleBack reuses resetState which already aborts clones and resets all fields.
  const handleBack = useCallback(() => {
    if (step === 'nested') {
      trackNestedBackAction()
    }
    resetState()
  }, [resetState, step, trackNestedBackAction])

  // Why: only the Setup step's "Add another project" back arrow counts as a
  // funnel event — the in-flight Back arrows on clone/remote/create are not
  // a Setup-step affordance. Keeping the emit scoped to this handler avoids
  // also tagging mid-clone backs.
  const handleSetupStepBack = useCallback(() => {
    trackSetupAction('back')
    handleBack()
  }, [handleBack, trackSetupAction])

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          // Why: Radix only fires onOpenChange for internal triggers (X icon, ESC,
          // outside-click), so this branch only runs for implicit closes — explicit
          // Skip is handled on its own renderer-side click handler. Implicit closes
          // on the Setup step are funnel-equivalent to Skip.
          if (step === 'setup') {
            trackSetupAction('skip')
            void finishImportedRepoWithoutOpening()
            return
          }
          if (step === 'nested' && !isAdding) {
            trackNestedBackAction()
          }
          closeModal()
          resetState()
        }
      }}
    >
      <DialogContent
        className={`min-w-0 overflow-hidden sm:max-w-lg [&>*]:min-w-0 ${
          step === 'nested' ? 'max-h-[calc(100vh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)]' : ''
        }`}
      >
        <AddRepoStepIndicator
          step={step}
          isInputStep={isInputStep}
          isAdding={isAdding}
          onBack={handleBack}
          onSetupBack={handleSetupStepBack}
        />
        <AddRepoDialogStepContent
          step={step}
          isRuntimeEnvironmentActive={isRuntimeEnvironmentActive}
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
          remotePath={remotePath}
          remoteError={remoteError}
          isAddingRemote={isAddingRemote}
          isScanningRemoteNested={isScanningRemoteNested}
          nestedScan={nestedScan}
          nestedSelectedPaths={nestedSelectedPaths}
          nestedGroupName={nestedGroupName}
          createName={createName}
          createParent={createParent}
          createKind={createKind}
          createError={createError}
          isCreating={isCreating}
          addedRepoName={addedRepo?.displayName ?? ''}
          hiddenWorktreeCount={hiddenWorktreeCount}
          primaryBranchName={primaryBranchName}
          onBrowse={handleBrowse}
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
          onOpenSshSettings={() => {
            closeModal()
            openSettingsTarget({ pane: 'ssh', repoId: null, sectionId: 'ssh' })
            openSettingsPage()
          }}
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
          onNestedBack={handleBack}
          onImportNestedRepos={(mode) => void handleImportNestedRepos(mode)}
          onCreateNameChange={(value) => {
            setCreateName(value)
            setCreateError(null)
          }}
          onCreateParentChange={(value) => {
            setCreateParent(value)
            setCreateError(null)
          }}
          onCreateKindChange={(kind) => {
            setCreateKind(kind)
            setCreateError(null)
          }}
          onPickCreateParent={handlePickParent}
          onCreate={handleCreate}
          onStartPrimaryWorktree={handleStartPrimaryWorktree}
          onUseExistingWorktrees={() => void handleUseExistingWorktrees()}
          onCreateWorktree={handleCreateWorktree}
          onConfigureRepo={handleConfigureRepo}
        />
      </DialogContent>
    </Dialog>
  )
})

export default AddRepoDialog
