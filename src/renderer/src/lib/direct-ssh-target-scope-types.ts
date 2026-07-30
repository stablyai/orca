import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  WorkspaceKey,
  Worktree
} from '../../../shared/types'

export type DirectSshGitRepoRef = {
  repoId: string
  executionHostId: `ssh:${string}`
}

export type DirectSshTargetScope = {
  catalogRevision: number
  gitRepos: DirectSshGitRepoRef[]
  gitWorktreeIds: Set<string>
  terminalWorkspaceKeys: Set<string>
  lineageWorkspaceKeys: Set<WorkspaceKey>
  ambiguousOwnerCount: number
  contradictoryOwnerCount: number
}

export type DirectSshRepoOwner = Pick<
  Repo,
  'id' | 'path' | 'projectGroupId' | 'connectionId' | 'executionHostId'
>
export type DirectSshWorktreeOwner = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'
>
export type DirectSshFolderOwner = Pick<
  FolderWorkspace,
  'id' | 'projectGroupId' | 'folderPath' | 'connectionId'
>
export type DirectSshGroupOwner = Pick<
  ProjectGroup,
  'id' | 'parentGroupId' | 'connectionId' | 'executionHostId'
>

export type DirectSshTargetScopeInput = {
  targetId: string
  catalogRevision: number
  repos: readonly DirectSshRepoOwner[]
  worktreesByRepo?: Readonly<Record<string, readonly DirectSshWorktreeOwner[]>>
  detectedWorktreesByRepo?: Readonly<
    Record<string, { worktrees: readonly DirectSshWorktreeOwner[] }>
  >
  folderWorkspaces?: readonly DirectSshFolderOwner[]
  projectGroups?: readonly DirectSshGroupOwner[]
  restoredRuntimeHostIdByWorkspaceSessionKey?: Readonly<Record<string, string | null | undefined>>
}
