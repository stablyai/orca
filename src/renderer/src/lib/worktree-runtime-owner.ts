import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GlobalSettings, Repo, Worktree } from '../../../shared/types'
import { getRepoIdFromWorktreeId } from '@/store/slices/worktree-helpers'

export type WorktreeRuntimeOwnerState = {
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  settings?: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null
  worktreesByRepo?: Record<string, readonly Pick<Worktree, 'id' | 'repoId'>[]>
}

function findWorktreeRepoId(
  worktreesByRepo: WorktreeRuntimeOwnerState['worktreesByRepo'],
  worktreeId: string
): string | null {
  for (const worktrees of Object.values(worktreesByRepo ?? {})) {
    const match = worktrees.find((worktree) => worktree.id === worktreeId)
    if (match) {
      return match.repoId
    }
  }
  return null
}

export function getRuntimeEnvironmentIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const repoId =
    findWorktreeRepoId(state.worktreesByRepo, worktreeId) ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos?.find((entry) => entry.id === repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    return parsed?.kind === 'runtime' ? parsed.environmentId : null
  }
  return state.settings?.activeRuntimeEnvironmentId?.trim() || null
}

export function getExecutionHostIdForWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): ExecutionHostId {
  if (!worktreeId) {
    return 'local'
  }
  const repoId =
    findWorktreeRepoId(state.worktreesByRepo, worktreeId) ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos?.find((entry) => entry.id === repoId)
  const hasExplicitOwner = Boolean(repo?.executionHostId?.trim() || repo?.connectionId?.trim())
  if (repo && hasExplicitOwner) {
    return getRepoExecutionHostId(repo)
  }
  const environmentId = state.settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? `runtime:${encodeURIComponent(environmentId)}` : 'local'
}

export function getSettingsForWorktreeRuntimeOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> {
  return {
    ...state.settings,
    activeRuntimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}
