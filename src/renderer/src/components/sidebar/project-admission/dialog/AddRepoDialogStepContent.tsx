import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { CloneStep } from './AddRepoCloneStep'
import { RemoteStep } from './AddRepoRemoteStep'
import { useServerSshProjects } from '../host-selection/use-server-ssh-projects'
import { CreateStep } from './AddRepoCreateStep'
import { AddRepoLocalStartStep } from './AddRepoStartSteps'
import { AddRepoServerPathStartStep } from './AddRepoServerStartStep'
import { AddRepoNestedImportStep } from '../nested-import/AddRepoNestedImportStep'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import type { NestedRepoScanResult } from '../../../../../../shared/project-group-types'
import type { SshConnectionState, SshTarget } from '../../../../../../shared/ssh-types'
import type { GitAvailability } from '../create/create-project-defaults'
import type { RepoKind } from '../../../../../../shared/repo-types'
import type { CloneFolderOverride } from '../clone-folder/use-clone-folder-override'

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
  cloneFolder: CloneFolderOverride | null
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
  createKind: RepoKind
  createError: string | null
  isCreating: boolean
  hostSelector?: ReactNode
  /** A WSL host's Windows drive refusal, with its "Add on this computer" action. */
  windowsDriveNotice?: ReactNode
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
  onCloneFolderNameChange: (name: string) => void
  onPickCloneDestination: () => void
  onClone: () => void
  onNestedGroupNameChange: (name: string) => void
  onNestedSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  onImportNestedRepos: (mode: 'group' | 'separate') => void
  onOpenNestedRootFolder: () => void
  onCreateNameChange: (name: string) => void
  onCreateParentChange: (parent: string) => void
  onCreateKindChange: (kind: RepoKind) => void
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
  cloneFolder,
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
  createKind,
  createError,
  isCreating,
  hostSelector,
  windowsDriveNotice,
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
  onCloneFolderNameChange,
  onPickCloneDestination,
  onClone,
  onNestedGroupNameChange,
  onNestedSelectedPathsChange,
  onImportNestedRepos,
  onOpenNestedRootFolder,
  onCreateNameChange,
  onCreateParentChange,
  onCreateKindChange,
  onPickCreateParent,
  onCreate
}: AddRepoDialogStepContentProps): React.JSX.Element | null {
  // The selected server owns the SSH hosts eligible for project creation.
  const serverSsh = useServerSshProjects(
    activeRuntimeEnvironmentId ?? null,
    selectedHostLabel ?? null,
    onOpenRemoteStep
  )
  // Server-owned SSH hosts need their paired server; return to Start if it disappears.
  if (step === 'add' || (step === 'remote' && !serverSsh)) {
    return (
      <AddRepoLocalStartStep
        notice={windowsDriveNotice}
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
        notice={windowsDriveNotice}
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
        cloneFolder={cloneFolder}
        cloneProgress={cloneProgress}
        isCloning={isCloning}
        disableDestinationPicker={isRuntimeEnvironmentActive}
        runtimeEnvironmentId={activeRuntimeEnvironmentId}
        cloneTargetLabel={isRuntimeEnvironmentActive ? selectedHostLabel : null}
        onUrlChange={onCloneUrlChange}
        onDestChange={onCloneDestinationChange}
        onFolderNameChange={onCloneFolderNameChange}
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
        createKind={createKind}
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
        onKindChange={onCreateKindChange}
        onPickParent={onPickCreateParent}
        onCreate={onCreate}
        submitDisabled={actionsDisabled}
        notice={windowsDriveNotice}
      />
    )
  }

  return null
}
