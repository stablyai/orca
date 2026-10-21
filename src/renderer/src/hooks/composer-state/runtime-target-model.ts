import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RefObject } from 'react'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { SshConnectionState, SshConnectionStatus } from '../../../../shared/ssh-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaVmRecipe } from '../../../../shared/orca-yaml-hook-types'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { ExecutionHostPlatformFact } from '@/lib/execution-host-facts'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import type { WorkspaceCreationTargetResolution } from '@/lib/project-host-workspace-target'
import type { ComposerMachineSelection } from './composer-machine-selection'

export type ComposerRuntimeTargetModel = {
  isProjectGroupTarget: boolean
  folderSourceRepos: Repo[]
  parsedFolderTargetHost: ParsedExecutionHost | null
  folderTargetRuntimeEnvironmentId: string | null
  folderTargetConnectionId: string | null
  folderTargetIsRemote: boolean
  folderTargetAgentDetectionTarget:
    | { kind: 'runtime'; environmentId: string; connectionId?: undefined }
    | { kind: 'ssh'; connectionId: string; environmentId?: undefined }
    | { kind: 'local'; environmentId?: undefined; connectionId?: undefined }
    | undefined
  folderTargetSshState: SshConnectionState | null
  folderTargetSshStatus: SshConnectionStatus | null
  folderTargetRequiresConnection: boolean
  folderTargetConnectInProgress: boolean
  folderPathStatusBlocksCreate: boolean
  pathStatusProjectError: string | null
  folderDetectedIds: TuiAgent[] | null
  folderDetectedAgentIds: Set<TuiAgent> | null
  selectedWorkspaceTarget: WorkspaceCreationTargetResolution
  resolvedRepoId: string
  selectedRepo: Repo | undefined
  selectedRepoIsGit: boolean
  selectedRepoExecutionHostId: ExecutionHostId | null
  selectedRepoHookContextKey: string | null
  selectedRepoAgentLaunchFact: ExecutionHostPlatformFact
  selectedRepoIsRemote: boolean
  selectedRepoStartupShell: AgentStartupShell | undefined
  selectedRepoProjectId: string | null
  selectedProjectId: string | null
  selectedProjectHostSetupId: string | null
  projectHostSetupOptions: ProjectHostSetupOption[]
  projectOptions: NewWorkspaceProjectOption[]
  /** Runtime that owns the selected repo; an unstamped repo follows focus. */
  selectedRepoRuntimeEnvironmentId: string | null
  /** Transport to the selected repo's owner; `null` with no repo selected. */
  selectedRepoTarget: RuntimeClientTarget | null
  selectedRecipeRepoId: string | null
  selectedRecipeRepoConnectionId: string | null
  ephemeralVmsEnabled: boolean
  ephemeralVmRecipes: OrcaVmRecipe[]
  selectedEphemeralVmRecipeId: string | null
  setSelectedEphemeralVmRecipeId: (recipeId: string | null) => void
  ephemeralVmRecipeError: string | null
  /** Null while machines are off or the target can't run on one. */
  machineSelection: ComposerMachineSelection | null
  selectedRepoConnectionId: string | null
  selectedRepoSshState: SshConnectionState | null
  selectedRepoSshStatus: SshConnectionStatus | null
  selectedRepoRequiresConnection: boolean
  selectedRepoConnectInProgress: boolean
  repoIdRef: RefObject<string>
}
