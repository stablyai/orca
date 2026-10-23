import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

export type DirectSshRepoOwner = Pick<
  Repo,
  'id' | 'path' | 'projectGroupId' | 'connectionId' | 'executionHostId'
>
export type DirectSshWorktreeOwner = Pick<
  Worktree,
  'id' | 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'
>

export type DirectSshTargetScopeInput = {
  targetId: string
  repos: readonly DirectSshRepoOwner[]
  worktreesByRepo?: Readonly<Record<string, readonly DirectSshWorktreeOwner[]>>
  detectedWorktreesByRepo?: Readonly<
    Record<string, { worktrees: readonly DirectSshWorktreeOwner[] }>
  >
  restoredRuntimeHostIdByWorkspaceSessionKey?: Readonly<Record<string, string | null | undefined>>
}
