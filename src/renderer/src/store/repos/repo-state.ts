import type { SshRepoReadoption } from '../../../../shared/ssh-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type {
  NestedRepoScanResult,
  ProjectGroup,
  ProjectGroupImportResult
} from '../../../../shared/project-group-types'
import type {
  Project,
  ProjectHostSetup,
  ProjectHostSetupCloneArgs,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  ProjectUpdateArgs
} from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../../../shared/folder-workspace-path-status'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export const ERROR_TOAST_DURATION = 60_000

export type RepoUpdate = Partial<
  Pick<
    Repo,
    | 'displayName'
    | 'badgeColor'
    | 'repoIcon'
    | 'upstream'
    | 'hookSettings'
    | 'worktreeBaseRef'
    | 'worktreeBasePath'
    | 'kind'
    | 'symlinkPaths'
    | 'issueSourcePreference'
    | 'forkSyncMode'
    | 'externalWorktreeVisibilityPromptDismissedAt'
    | 'externalWorktreeInboxBaselinePaths'
    | 'importedExternalWorktreePaths'
    | 'customWorktreeVisibilitySources'
    | 'worktreeVisibilitySourcePreferences'
    | 'projectGroupId'
    | 'projectGroupOrder'
  >
> & {
  externalWorktreeVisibility?: Repo['externalWorktreeVisibility'] | null
  agentWorktreeVisibility?: Repo['agentWorktreeVisibility'] | null
  sourceControlAi?: Repo['sourceControlAi'] | null
  externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
}

export type ProjectUpdate = ProjectUpdateArgs['updates']

export type FolderWorkspaceUpdates = Partial<
  Pick<
    FolderWorkspace,
    | 'name'
    | 'folderPath'
    | 'linkedTask'
    | 'linkedTaskSourceContext'
    | 'comment'
    | 'isArchived'
    | 'isUnread'
    | 'isPinned'
    | 'sortOrder'
    | 'manualOrder'
    | 'workspaceStatus'
    | 'createdWithAgent'
    | 'pendingFirstAgentMessageRename'
    | 'firstAgentMessageRenameError'
    | 'lastActivityAt'
    | 'diffComments'
  >
>

export type NestedRepoScanControls = {
  scanId?: string
  onProgress?: (scan: NestedRepoScanResult) => void
  runtimeEnvironmentId?: string | null
}

export type NestedRepoScanCancelOptions = {
  runtimeEnvironmentId?: string | null
}

export type FolderWorkspacePathStatusCacheEntry = {
  status: FolderWorkspacePathStatus
  checkedAt: number
  requestSnapshot: string
}

export type DeleteProjectGroupWithContainedProjectsOptions = {
  removeContainedProjects: boolean
  // hostId disambiguates which host's group row to delete when the id exists on multiple hosts.
  hostId?: ExecutionHostId
}

export type AllHostCatalogFetchOptions = {
  remoteHosts?: 'include' | 'skip'
}

export type ProjectRemovalFailure = {
  projectId: string
  reason: string
}

export type DeleteProjectGroupWithContainedProjectsResult =
  | {
      status: 'deleted-group'
      groupId: string
      requestedProjectIds: string[]
      removedProjectIds: string[]
      failedProjectRemovals: ProjectRemovalFailure[]
    }
  | {
      status: 'missing-group' | 'group-delete-failed'
      groupId: string
      requestedProjectIds: string[]
      removedProjectIds: []
      failedProjectRemovals: []
    }

export type FolderWorkspacePathStatusRouteOptions = { runtimeEnvironmentId?: string | null }

export type AddRepoPathOptions = {
  runtimeEnvironmentId?: string | null
  /** Overrides the host's basename naming for the new project. */
  displayName?: string
}

export type RuntimeCatalogFetchOptions = { runtimeEnvironmentId?: string | null }

export type RepoSlice = {
  repos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  folderWorkspacePathStatuses: Record<string, FolderWorkspacePathStatusCacheEntry>
  activeRepoId: string | null
  // Monotonic sequence so overlapping catalog fetches can drop stale same-host results (#7020).
  reposFetchGeneration: number
  pendingSshRepoReadoptions: readonly SshRepoReadoption[]
  recordSshRepoReadoptions: (readoptions: readonly SshRepoReadoption[]) => void
  fetchRepos: (options?: RuntimeCatalogFetchOptions) => Promise<void>
  fetchReposForAllHosts: (options?: AllHostCatalogFetchOptions) => Promise<void>
  awaitLocalRepoCatalogSettlement: () => Promise<void>
  fetchRuntimeEnvironmentRepos: (environmentId: string) => Promise<Repo[]>
  fetchProjectGroups: (options?: RuntimeCatalogFetchOptions) => Promise<void>
  fetchProjectGroupsForAllHosts: (options?: AllHostCatalogFetchOptions) => Promise<void>
  fetchFolderWorkspaces: (options?: RuntimeCatalogFetchOptions) => Promise<void>
  fetchFolderWorkspacesForAllHosts: (options?: AllHostCatalogFetchOptions) => Promise<void>
  addRepo: () => Promise<Repo | null>
  addRepoPath: (
    path: string,
    kind?: 'git' | 'folder',
    options?: AddRepoPathOptions
  ) => Promise<Repo | null>
  setupProjectExistingFolder: (
    args: ProjectHostSetupExistingFolderArgs
  ) => Promise<ProjectHostSetupResult | null>
  createProjectHostSetup: (
    args: ProjectHostSetupCreateArgs
  ) => Promise<ProjectHostSetupCreateResult | null>
  updateProjectHostSetup: (
    args: ProjectHostSetupUpdateArgs
  ) => Promise<ProjectHostSetupUpdateResult | null>
  deleteProjectHostSetup: (
    args: ProjectHostSetupDeleteArgs
  ) => Promise<ProjectHostSetupDeleteResult | null>
  setupProjectClone: (args: ProjectHostSetupCloneArgs) => Promise<ProjectHostSetupResult | null>
  addNonGitFolder: (path: string, options?: AddRepoPathOptions) => Promise<Repo | null>
  scanNestedRepos: (
    path: string,
    connectionId?: string,
    controls?: NestedRepoScanControls
  ) => Promise<NestedRepoScanResult | null>
  cancelNestedRepoScan: (scanId: string, options?: NestedRepoScanCancelOptions) => Promise<boolean>
  importNestedRepos: (args: {
    parentPath: string
    groupName: string
    projectPaths: string[]
    connectionId?: string
    scanId?: string
    runtimeEnvironmentId?: string | null
    mode: 'group' | 'separate'
  }) => Promise<ProjectGroupImportResult | null>
  createProjectGroup: (name: string) => Promise<ProjectGroup | null>
  createFolderWorkspace: (
    args: {
      projectGroupId: string
      name?: string
      folderPath?: string | null
      connectionId?: string | null
      linkedTask?: FolderWorkspace['linkedTask']
      linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
      createdWithAgent?: FolderWorkspace['createdWithAgent']
      pendingFirstAgentMessageRename?: boolean
    },
    options?: FolderWorkspacePathStatusRouteOptions
  ) => Promise<FolderWorkspace | null>
  getFolderWorkspacePathStatusCacheKey: (
    request: FolderWorkspacePathStatusRequest,
    options?: FolderWorkspacePathStatusRouteOptions
  ) => string
  getFreshFolderWorkspacePathStatus: (
    request: FolderWorkspacePathStatusRequest,
    options?: FolderWorkspacePathStatusRouteOptions
  ) => FolderWorkspacePathStatus | null
  fetchFolderWorkspacePathStatus: (
    request: FolderWorkspacePathStatusRequest,
    options?: { force?: boolean } & FolderWorkspacePathStatusRouteOptions
  ) => Promise<FolderWorkspacePathStatus | null>
  updateFolderWorkspace: (
    folderWorkspaceId: string,
    updates: FolderWorkspaceUpdates,
    options?: { executionHostId?: ExecutionHostId }
  ) => Promise<boolean>
  deleteFolderWorkspace: (
    folderWorkspaceId: string,
    options?: { executionHostId?: ExecutionHostId }
  ) => Promise<boolean>
  // options.hostId targets a specific host's row + RPC target when the id exists on multiple hosts; else the group's own host owns the call.
  updateProjectGroup: (
    groupId: string,
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>,
    options?: { hostId?: ExecutionHostId }
  ) => Promise<boolean>
  deleteProjectGroup: (groupId: string, options?: { hostId?: ExecutionHostId }) => Promise<boolean>
  deleteProjectGroupWithContainedProjects: (
    groupId: string,
    options: DeleteProjectGroupWithContainedProjectsOptions
  ) => Promise<DeleteProjectGroupWithContainedProjectsResult>
  moveProjectToGroup: (
    projectId: string,
    groupId: string | null,
    order?: number
  ) => Promise<boolean>
  // options.hostId disambiguates which host's row to remove when the id exists on multiple hosts; else the focused host is assumed.
  // options.errorFeedback defaults to 'silent' so bulk/background callers keep their own aggregate reporting.
  removeProject: (
    projectId: string,
    options?: { hostId?: ExecutionHostId; errorFeedback?: 'toast' | 'silent' }
  ) => Promise<void>
  updateProject: (projectId: string, updates: ProjectUpdate) => Promise<boolean>
  // options.hostId targets a specific host's row + RPC target when the id exists on multiple hosts; else the focused host is assumed.
  updateRepo: (
    projectId: string,
    updates: RepoUpdate,
    options?: { hostId?: ExecutionHostId }
  ) => Promise<boolean>
  setActiveRepo: (projectId: string | null) => void
  reorderRepos: (orderedIds: string[]) => Promise<void>
}
