import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { CloneStep } from './AddRepoCloneStep'
import { RemoteStep } from './AddRepoRemoteStep'
import { CreateStep } from './AddRepoCreateStep'
import { AddRepoLocalStartStep } from './AddRepoStartSteps'
import { AddRepoServerPathStartStep } from './AddRepoServerStartStep'
import { AddRepoNestedImportStep } from './AddRepoNestedImportStep'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { NestedRepoScanResult } from '../../../../shared/types'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import type { GitAvailability } from './create-project-defaults'

type AddRepoDialogStepContentProps = {
  step: AddRepoDialogStep
  isRuntimeEnvironmentActive: boolean
  activeRuntimeEnvironmentId: string | null | undefined
  isSshLikely: boolean
  repoCount: number
  isAdding: boolean
  addProjectBusyLabel: string | null
  nestedScanInProgress: boolean
  nestedScanId: string | null
  serverPath: string
  isAddingServerPath: boolean
  cloneUrl: string
  cloneDestination: string
  cloneError: string | null
  cloneProgress: { phase: string; percent: number } | null
  isCloning: boolean
  sshTargets: (SshTarget & { state?: SshConnectionState })[]
  selectedTargetId: string | null
  selectedSshTargetId?: string | null
  selectedHostLabel?: string | null
  lockSshTargetSelection?: boolean
  remotePath: string
  remoteError: string | null
  isAddingRemote: boolean
  isScanningRemoteNested: boolean
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  nestedGroupName: string
  createName: string
  createParent: string
  createError: string | null
  isCreating: boolean
  hostSelector?: ReactNode
  showRemoteAction?: boolean
  canCreateProject?: boolean
  manualCreateParentEntry?: boolean
  browseHostKind?: 'local' | 'ssh' | 'runtime'
  createDefaultParent: string
  createGitAvailability: GitAvailability
  createRuntimeParentStatus: 'idle' | 'checking' | 'failed'
  createParentDefaultPending: boolean
  onBrowse: () => void
  onOpenCloneStep: () => void
  onOpenCreateStep: () => void
  onOpenRemoteStep: (targetId?: string | null) => void
  onStopNestedScan: () => void
  onServerPathChange: (path: string) => void
  onAddServerPath: (kind: 'git' | 'folder') => void
  onSelectTarget: (id: string) => void
  onRemotePathChange: (path: string) => void
  onAddRemoteRepo: () => void
  onOpenSshSettings: () => void
  onConnectTarget: (id: string) => Promise<void>
  onStopRemoteNestedScan: () => void
  onCloneUrlChange: (url: string) => void
  onCloneDestinationChange: (destination: string) => void
  onPickCloneDestination: () => void
  onClone: () => void
  onNestedGroupNameChange: (name: string) => void
  onNestedSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onImportNestedRepos: (mode: 'group' | 'separate') => void
  onCreateNameChange: (name: string) => void
  onCreateParentChange: (parent: string) => void
  onPickCreateParent: () => void
  onCreate: () => void
}

export function AddRepoDialogStepContent({
  step,
  isRuntimeEnvironmentActive,
  activeRuntimeEnvironmentId,
  isSshLikely,
  repoCount,
  isAdding,
  addProjectBusyLabel,
  nestedScanInProgress,
  nestedScanId,
  serverPath,
  isAddingServerPath,
  cloneUrl,
  cloneDestination,
  cloneError,
  cloneProgress,
  isCloning,
  sshTargets,
  selectedTargetId,
  selectedSshTargetId,
  selectedHostLabel,
  lockSshTargetSelection = false,
  remotePath,
  remoteError,
  isAddingRemote,
  isScanningRemoteNested,
  nestedScan,
  nestedSelectedPaths,
  nestedGroupName,
  createName,
  createParent,
  createError,
  isCreating,
  hostSelector,
  showRemoteAction = true,
  canCreateProject = true,
  manualCreateParentEntry = isRuntimeEnvironmentActive,
  browseHostKind = 'local',
  createDefaultParent,
  createGitAvailability,
  createRuntimeParentStatus,
  createParentDefaultPending,
  onBrowse,
  onOpenCloneStep,
  onOpenCreateStep,
  onOpenRemoteStep,
  onStopNestedScan,
  onServerPathChange,
  onAddServerPath,
  onSelectTarget,
  onRemotePathChange,
  onAddRemoteRepo,
  onOpenSshSettings,
  onConnectTarget,
  onStopRemoteNestedScan,
  onCloneUrlChange,
  onCloneDestinationChange,
  onPickCloneDestination,
  onClone,
  onNestedGroupNameChange,
  onNestedSelectedPathsChange,
  onImportNestedRepos,
  onCreateNameChange,
  onCreateParentChange,
  onPickCreateParent,
  onCreate
}: AddRepoDialogStepContentProps): React.JSX.Element | null {
  if (step === 'add') {
    return (
      <AddRepoLocalStartStep
        repoCount={repoCount}
        isSshLikely={isSshLikely}
        isAdding={isAdding}
        addProjectBusyLabel={addProjectBusyLabel}
        nestedScanInProgress={nestedScanInProgress}
        nestedScanId={nestedScanId}
        hostSelector={hostSelector}
        showRemoteAction={showRemoteAction}
        canCreateProject={canCreateProject}
        browseHostKind={browseHostKind}
        onBrowse={onBrowse}
        onOpenCloneStep={onOpenCloneStep}
        onOpenRemoteStep={onOpenRemoteStep}
        onOpenCreateStep={onOpenCreateStep}
        onStopNestedScan={onStopNestedScan}
      />
    )
  }

  if (step === 'server-path') {
    return (
      <AddRepoServerPathStartStep
        serverPath={serverPath}
        runtimeEnvironmentId={activeRuntimeEnvironmentId}
        isAddingServerPath={isAddingServerPath}
        addProjectBusyLabel={addProjectBusyLabel}
        hostSelector={hostSelector}
        initialBrowsing
        onServerPathChange={onServerPathChange}
        onAddServerPath={onAddServerPath}
        onOpenCloneStep={onOpenCloneStep}
        onOpenCreateStep={onOpenCreateStep}
      />
    )
  }

  if (step === 'remote') {
    return (
      <RemoteStep
        sshTargets={sshTargets}
        selectedTargetId={selectedTargetId}
        lockSshTargetSelection={lockSshTargetSelection}
        remotePath={remotePath}
        remoteError={remoteError}
        isAddingRemote={isAddingRemote}
        isScanningNested={isScanningRemoteNested}
        onSelectTarget={onSelectTarget}
        onRemotePathChange={onRemotePathChange}
        onAdd={onAddRemoteRepo}
        onOpenSshSettings={onOpenSshSettings}
        onConnectTarget={onConnectTarget}
        onStopNestedScan={onStopRemoteNestedScan}
      />
    )
  }

  if (step === 'clone') {
    return (
      <CloneStep
        cloneUrl={cloneUrl}
        cloneDestination={cloneDestination}
        cloneError={cloneError}
        cloneProgress={cloneProgress}
        isCloning={isCloning}
        disableDestinationPicker={isRuntimeEnvironmentActive}
        runtimeEnvironmentId={activeRuntimeEnvironmentId}
        sshTargetId={selectedSshTargetId}
        cloneTargetLabel={
          isRuntimeEnvironmentActive || selectedSshTargetId ? selectedHostLabel : null
        }
        onUrlChange={onCloneUrlChange}
        onDestChange={onCloneDestinationChange}
        onPickDestination={onPickCloneDestination}
        onClone={onClone}
      />
    )
  }

  if (step === 'nested' && nestedScan) {
    return (
      <AddRepoNestedImportStep
        scan={nestedScan}
        groupName={nestedGroupName}
        selectedPaths={nestedSelectedPaths}
        isAdding={isAdding}
        scanInProgress={nestedScanInProgress}
        onGroupNameChange={onNestedGroupNameChange}
        onSelectedPathsChange={onNestedSelectedPathsChange}
        onImport={onImportNestedRepos}
        onStopScan={onStopNestedScan}
      />
    )
  }

  if (step === 'create') {
    return (
      <CreateStep
        createName={createName}
        createParent={createParent}
        createError={createError}
        isCreating={isCreating}
        defaultParent={createDefaultParent}
        gitAvailability={createGitAvailability}
        runtimeParentStatus={createRuntimeParentStatus}
        parentDefaultPending={createParentDefaultPending}
        manualParentEntry={manualCreateParentEntry}
        runtimeEnvironmentId={activeRuntimeEnvironmentId}
        sshTargetId={selectedSshTargetId}
        onNameChange={onCreateNameChange}
        onParentChange={onCreateParentChange}
        onPickParent={onPickCreateParent}
        onCreate={onCreate}
      />
    )
  }

  return null
}
