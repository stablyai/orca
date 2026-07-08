import type { AppState } from '../types'
import type { WorktreeTodoScope } from '../../../../shared/types'
import { findRepoForHost } from './repo-host-identity'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'

// Why: mirror diffComments' settingsForWorktreeOwner so a worktree owned by a
// runtime environment persists through that environment's RPC target.
function settingsForWorktreeOwner(state: AppState, worktreeId: string): AppState['settings'] {
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return state.settings
    ? { ...state.settings, activeRuntimeEnvironmentId: runtimeEnvironmentId }
    : ({ activeRuntimeEnvironmentId: runtimeEnvironmentId } as AppState['settings'])
}

// Why: mirror the repo slice's owner-settings resolution so a repo pinned to a
// runtime/ssh host persists through the right target instead of the active one.
function settingsForRepoOwner(state: AppState, repoId: string): AppState['settings'] {
  const repo = findRepoForHost(state.repos, repoId, { settings: state.settings })
  if (!repo || (!repo.executionHostId && !repo.connectionId)) {
    return state.settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (parsed?.kind === 'runtime') {
    return state.settings
      ? { ...state.settings, activeRuntimeEnvironmentId: parsed.environmentId }
      : ({ activeRuntimeEnvironmentId: parsed.environmentId } as AppState['settings'])
  }
  if (
    (parsed?.kind === 'local' || parsed?.kind === 'ssh') &&
    state.settings?.activeRuntimeEnvironmentId
  ) {
    return { ...state.settings, activeRuntimeEnvironmentId: null }
  }
  return state.settings
}

// Why: route a todo write to the persistence target that owns it — the worktree's
// runtime environment, or the repo's pinned host — so per-worktree and per-project
// todos land on the same target their other metadata uses.
export function settingsForOwner(
  state: AppState,
  scope: WorktreeTodoScope,
  ownerId: string
): AppState['settings'] {
  return scope === 'worktree'
    ? settingsForWorktreeOwner(state, ownerId)
    : settingsForRepoOwner(state, ownerId)
}
