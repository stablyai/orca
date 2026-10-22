import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { CloneStep } from './AddRepoCloneStep'
import { RemoteStep } from './AddRepoRemoteStep'
import { useServerSshProjects } from './use-server-ssh-projects'
import { CreateStep } from './AddRepoCreateStep'
import { AddRepoLocalStartStep } from './AddRepoStartSteps'
import { AddRepoServerPathStartStep } from './AddRepoServerStartStep'
import { AddRepoNestedImportStep } from './AddRepoNestedImportStep'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import type { GitAvailability } from './create-project-defaults'

type AddRepoDialogStepContentProps = {
  step: AddRepoDialogStep
  isRuntimeEnvironmentActive: boolean
  activeRuntimeEnvironmentId: string | null | undefined
  repoCount: number
  isAdding: boolean
  addProjectBusyLabel: string | null
  nestedScanInProgress: boolean
  nestedScanId: string | null
  serverPath: string
  /** The path came from Windows' picker or an Explorer drop, so the host's browser is skipped. */
  serverPathPrefilled?: boolean
  isAddingServerPath: boolean
  cloneUrl: string
  cloneDestination: string
  cloneError: string | null
  cloneProgress: { phase: string; percent: number } | null
  isCloning: boolean
  sshTargets: (SshTarget & { state?: SshConnectionState })[]
  selectedTargetId: string | null
  selectedHostLabel?: string | null
  remotePath: string
  remoteError: string | null
  isAddingRemote: boolean
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  nestedGroupName: string
  createName: string
  createParent: string
  createError: string | null
  isCreating: boolean
  hostSelector?: ReactNode
  actionsDisabled?: boolean
  manualCreateParentEntry?: boolean
  browseHostKind?: 'local' | 'runtime'
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
  onConnectTarget: (id: string) => Promise<void>
  onCloneUrlChange: (url: string) => void
  onCloneDestinationChange: (destination: string) => void
  onPickCloneDestination: () => void
  onClone: () => void
  onNestedGroupNameChange: (name: string) => void
  onNestedSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onImportNestedRepos: (mode: 'group' | 'separate') => void
  onOpenNestedRootFolder: () => void
  onCreateNameChange: (name: string) => void
  onCreateParentChange: (parent: string) => void
  onPickCreateParent: () => void
  onCreate: () => void
}

export function AddRepoDialogStepContent({
  step,
  isRuntimeEnvironmentActive,
  activeRuntimeEnvironmentId,
  repoCount,
  isAdding,
  addProjectBusyLabel,
  nestedScanInProgress,
  nestedScanId,
  serverPath,
  serverPathPrefilled = false,
  isAddingServerPath,
  cloneUrl,
  cloneDestination,
  cloneError,
  cloneProgress,
  isCloning,
  sshTargets,
  selectedTargetId,
  selectedHostLabel,
  remotePath,
  remoteError,
  isAddingRemote,
  nestedScan,
  nestedSelectedPaths,
  nestedGroupName,
  createName,
  createParent,
  createError,
  isCreating,
  hostSelector,
  actionsDisabled = false,
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
  onConnectTarget,
  onCloneUrlChange,
  onCloneDestinationChange,
  onPickCloneDestination,
  onClone,
  onNestedGroupNameChange,
  onNestedSelectedPathsChange,
  onImportNestedRepos,
  onOpenNestedRootFolder,
  onCreateNameChange,
  onCreateParentChange,
  onPickCreateParent,
  onCreate
}: AddRepoDialogStepContentProps): React.JSX.Element | null {
  // Why here: the selected server decides whether its own SSH hosts can hold a new project.
  const serverSsh = useServerSshProjects(
    activeRuntimeEnvironmentId ?? null,
    selectedHostLabel ?? null,
    onOpenRemoteStep
  )
  // Why the start step for a remote step without a server: SSH hosts hold projects only through
  // the paired server that reaches them, so there is nothing to show if that server went away.
  if (step === 'add' || (step === 'remote' && !serverSsh)) {
    return (
      <AddRepoLocalStartStep
        repoCount={repoCount}
        isAdding={isAdding}
        addProjectBusyLabel={addProjectBusyLabel}
        nestedScanInProgress={nestedScanInProgress}
        nestedScanId={nestedScanId}
        hostSelector={hostSelector}
        actionsDisabled={actionsDisabled}
        browseHostKind={browseHostKind}
        offersServerSshHosts={serverSsh !== null}
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
        initialBrowsing={!(serverPathPrefilled && serverPath.trim())}
        onServerPathChange={onServerPathChange}
        onAddServerPath={onAddServerPath}
        onOpenCloneStep={onOpenCloneStep}
        onOpenCreateStep={onOpenCreateStep}
      />
    )
  }

  if (step === 'remote' && serverSsh) {
    return (
      <RemoteStep
        sshTargets={sshTargets}
        selectedTargetId={selectedTargetId}
        remotePath={remotePath}
        remoteError={remoteError}
        isAddingRemote={isAddingRemote}
        onSelectTarget={onSelectTarget}
        onRemotePathChange={onRemotePathChange}
        onAdd={onAddRemoteRepo}
        onConnectTarget={onConnectTarget}
        server={serverSsh}
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
        cloneTargetLabel={isRuntimeEnvironmentActive ? selectedHostLabel : null}
        onUrlChange={onCloneUrlChange}
        onDestChange={onCloneDestinationChange}
        onPickDestination={onPickCloneDestination}
        onClone={onClone}
        submitDisabled={actionsDisabled}
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
        onOpenAsFolder={onOpenNestedRootFolder}
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
        onNameChange={onCreateNameChange}
        onParentChange={onCreateParentChange}
        onPickParent={onPickCreateParent}
        onCreate={onCreate}
        submitDisabled={actionsDisabled}
      />
    )
  }

  return null
}
