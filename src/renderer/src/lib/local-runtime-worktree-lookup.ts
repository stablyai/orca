import type { AppState } from '@/store/types'
import { getIndexedRepoMap, getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

export type LocalProjectRuntimeState = Pick<
  AppState,
  'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
>

// Why: the shared indexes are WeakMap-keyed on slice identity, so a fresh `{}`
// or `[]` fallback would miss the cache on every read.
const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}
export const EMPTY_REPOS: AppState['repos'] = []

export function getLocalRuntimeRepoForWorktree(
  state: LocalProjectRuntimeState,
  worktree?: Pick<Worktree, 'repoId'> | null
): Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> | undefined {
  const repoId = worktree?.repoId ?? state.activeRepoId
  return repoId ? getIndexedRepoMap(state.repos ?? EMPTY_REPOS).get(repoId) : undefined
}

export function isLocalRuntimeRepo(
  repo?: Pick<Repo, 'connectionId' | 'executionHostId'> | null
): repo is Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> {
  if (!repo) {
    return false
  }
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

export function isLocalRuntimeWorktree(worktree?: Pick<Worktree, 'hostId'> | null): boolean {
  return !worktree?.hostId || worktree.hostId === LOCAL_EXECUTION_HOST_ID
}

export function getLocalRuntimeProject(
  state: LocalProjectRuntimeState,
  projectId: string,
  repoId: string
) {
  return state.projects?.find(
    (entry) =>
      entry.id === projectId || entry.id === repoId || entry.sourceRepoIds?.includes(repoId)
  )
}

export function getLocalWorktree(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null
): Pick<Worktree, 'id' | 'repoId' | 'projectId' | 'path' | 'hostId'> | null {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  if (!targetWorktreeId) {
    return null
  }
  return (
    getIndexedWorktreeById(state.worktreesByRepo ?? EMPTY_WORKTREES_BY_REPO, targetWorktreeId) ??
    null
  )
}

export function getLocalPreflightProjectId(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null
): string {
  const activeWorktree = getLocalWorktree(state, worktreeId)
  return (
    activeWorktree?.projectId ?? activeWorktree?.repoId ?? state.activeRepoId ?? 'local-project'
  )
}
