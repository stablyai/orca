import type { AppState } from '@/store/types'
import { settingsForRepoOwner } from '@/store/repos/owner-routing'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../../shared/execution-host'

type ForkWorktreeOwner = Pick<Worktree, 'repoId' | 'hostId' | 'runtimeOwnerEnvironmentId'>

/** The repo that owns a fork source or child, matched by host so duplicate repo ids never cross hosts. */
export function findForkWorktreeRepo(
  state: Pick<AppState, 'repos' | 'settings'>,
  worktree: ForkWorktreeOwner
): Repo | null {
  // Why: a runtime-owned row's hostId is the host's own view; the renderer keys its repo by runtime.
  const hostId = worktree.runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(worktree.runtimeOwnerEnvironmentId)
    : worktree.hostId
  return (
    (hostId ? findRepoForHost(state.repos, worktree.repoId, { hostId }) : null) ??
    findRepoForHost(state.repos, worktree.repoId, { settings: state.settings })
  )
}

/** Runtime routing for the repo `findForkWorktreeRepo` picked, so git calls reach the same host. */
export function forkWorktreeOwnerSettings(
  state: Pick<AppState, 'repos' | 'settings'>,
  worktree: ForkWorktreeOwner
): ReturnType<typeof settingsForRepoOwner> {
  const repo = findForkWorktreeRepo(state, worktree)
  return settingsForRepoOwner(
    state,
    worktree.repoId,
    repo ? getRepoExecutionHostId(repo) : undefined
  )
}
