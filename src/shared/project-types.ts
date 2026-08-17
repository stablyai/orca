import type { ExecutionHostId } from './execution-host'
import type { RepoIcon } from './repo-icon'
import type { GitRemoteIdentity } from './git-remote-identity'
import type { LocalWindowsRuntimePreference } from './project-execution-runtime'
import type { RepoHookSettings } from './orca-yaml-hook-types'
import type { RepoSourceControlAiOverrides } from './source-control-ai-types'
import type { Repo, RepoKind } from './repo-types'
import type { TerminalBackendActivation, TerminalBackendPreference } from './terminal-backend'

export type ProjectProviderIdentity = {
  provider: 'github'
  owner: string
  repo: string
  host?: string
}

export type Project = {
  id: string
  displayName: string
  badgeColor: string
  repoIcon?: RepoIcon | null
  kind?: RepoKind
  providerIdentity?: ProjectProviderIdentity
  gitRemoteIdentity?: GitRemoteIdentity
  /** Local Windows projects inherit the global runtime default unless this override is set. */
  localWindowsRuntimePreference?: LocalWindowsRuntimePreference
  /** Stable named Herdr session. Undefined derives a deterministic name from the project id. */
  herdrSessionName?: string
  /** Desired backend for project hosts that have not been activated yet. */
  terminalBackendPreference?: TerminalBackendPreference
  /** Active backend is durable per host so changing defaults cannot switch live terminals. */
  terminalBackendByHost?: Partial<Record<ExecutionHostId, TerminalBackendActivation>>
  sourceRepoIds: string[]
  createdAt: number
  updatedAt: number
}

export type ProjectUpdateArgs = {
  projectId: string
  updates: {
    localWindowsRuntimePreference?: Project['localWindowsRuntimePreference']
    herdrSessionName?: string | null
    terminalBackendPreference?: TerminalBackendPreference | null
    terminalBackendByHost?: Project['terminalBackendByHost'] | null
  }
}

export type ProjectHostSetupState = 'ready' | 'not-set-up' | 'setting-up' | 'error' | 'unsupported'
export type ProjectHostSetupMethod =
  | 'legacy-repo'
  | 'imported-existing-folder'
  | 'cloned'
  | 'provisioned'
export type RepoProjectHostSetupMethod = Extract<
  ProjectHostSetupMethod,
  'imported-existing-folder' | 'cloned'
>

export type ProjectHostSetup = {
  id: string
  projectId: string
  hostId: ExecutionHostId
  repoId: string
  path: string
  displayName: string
  kind?: RepoKind
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  /** Renderer projection of the paired runtime that owns this setup's transport. */
  runtimeOwnerEnvironmentId?: string
  worktreeBasePath?: string
  hookSettings?: RepoHookSettings
  gitUsername?: string
  setupState: ProjectHostSetupState
  setupMethod: ProjectHostSetupMethod
  sourceControlAi?: RepoSourceControlAiOverrides
  createdAt: number
  updatedAt: number
}

export type ProjectHostSetupExistingFolderArgs = {
  projectId: string
  projectProviderIdentity?: ProjectProviderIdentity
  hostId: ExecutionHostId
  path: string
  kind?: RepoKind
  displayName?: string
  setupMethod?: RepoProjectHostSetupMethod
}

export type ProjectHostSetupCreateArgs = {
  projectId: string
  hostId: ExecutionHostId
  setupId?: string
  path?: string
  kind?: RepoKind
  displayName?: string
  worktreeBasePath?: string
  gitUsername?: string
  setupState?: ProjectHostSetupState
  setupMethod?: Exclude<ProjectHostSetupMethod, 'legacy-repo'>
}

export type ProjectHostSetupCloneArgs = {
  projectId: string
  projectProviderIdentity?: ProjectProviderIdentity
  hostId: ExecutionHostId
  url: string
  destination: string
  displayName?: string
}

export type ProjectHostSetupUpdateArgs = {
  setupId: string
  updates: Partial<
    Pick<
      ProjectHostSetup,
      | 'displayName'
      | 'path'
      | 'worktreeBasePath'
      | 'setupState'
      | 'setupMethod'
      | 'gitUsername'
      | 'kind'
    >
  >
}

export type ProjectHostSetupDeleteArgs = {
  setupId: string
}

export type ProjectHostSetupResult = {
  project: Project
  setup: ProjectHostSetup
  repo: Repo
}

export type ProjectHostSetupCreateResult = {
  project: Project
  setup: ProjectHostSetup
}

export type ProjectHostSetupUpdateResult = {
  project: Project
  setup: ProjectHostSetup
  repo?: Repo
}

export type ProjectHostSetupDeleteResult = {
  project: Project
  setup: ProjectHostSetup
  repo?: Repo
}
