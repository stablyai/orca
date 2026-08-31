import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../shared/cross-platform-path'
import {
  getFolderWorkspaceCandidateRepos,
  getFolderWorkspaceConnectionId
} from './folder-workspace-connection'
import {
  normalizeWorktreeLookupId,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'

type ConnectionOwnerState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>

export function createConnectionIdForFileSelector(
  worktreeId: string | null,
  filePath: string,
  { skip = false }: { skip?: boolean } = {}
): (state: ConnectionOwnerState) => string | null | undefined {
  let previousSlices: ConnectionOwnerState | null = null
  let previousResult: string | null | undefined
  return (state) => {
    if (skip) {
      return undefined
    }
    if (
      previousSlices?.folderWorkspaces === state.folderWorkspaces &&
      previousSlices.projectGroups === state.projectGroups &&
      previousSlices.repos === state.repos &&
      previousSlices.worktreesByRepo === state.worktreesByRepo
    ) {
      return previousResult
    }
    previousSlices = {
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }
    previousResult = getConnectionIdForFileFromState(state, worktreeId, filePath)
    return previousResult
  }
}

export function getConnectionIdFromState(
  state: ConnectionOwnerState,
  worktreeId: string | null
): string | null | undefined {
  if (!worktreeId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId)
  }
  const rawWorktreeId = normalizeWorktreeLookupId(worktreeId)
  if (rawWorktreeId === null) {
    return undefined
  }
  // Why: owner resolution runs from retained Zustand selectors, so unrelated
  // store writes must not flatten every worktree or scan every repository.
  // Ambiguous ids are intentionally unresolved: a local and SSH workspace can
  // share the same path-derived id, and guessing would route file operations to
  // the wrong host.
  const worktreeResolution = resolveIndexedWorktreeOwner(state.worktreesByRepo, rawWorktreeId)
  if (worktreeResolution.kind === 'ambiguous') {
    return undefined
  }
  const repoId =
    worktreeResolution.kind === 'resolved'
      ? worktreeResolution.owner.repoId
      : getRepoIdFromWorktreeId(rawWorktreeId)
  const repoResolution = resolveIndexedRepoOwner(state.repos, repoId)
  return repoResolution.kind === 'resolved'
    ? (repoResolution.owner.connectionId ?? null)
    : undefined
}

export function getConnectionIdForFileFromState(
  state: ConnectionOwnerState,
  worktreeId: string | null,
  filePath: string
): string | null | undefined {
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId !== undefined || !worktreeId) {
    return connectionId
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type !== 'folder') {
    return undefined
  }
  const candidateRepos = getFolderWorkspaceCandidateRepos(
    state,
    parsedWorkspaceKey.folderWorkspaceId
  )
  const matchingRepos = candidateRepos
    .filter((repo) => isPathInsideOrEqual(repo.path, filePath))
    .map((repo) => ({ repo, normalizedPath: normalizeRuntimePathForComparison(repo.path) }))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length)
  const longestPathLength = matchingRepos[0]?.normalizedPath.length
  if (!longestPathLength) {
    return undefined
  }
  const connectionIds = new Set(
    matchingRepos
      .filter((candidate) => candidate.normalizedPath.length === longestPathLength)
      .map(({ repo }) => repo.connectionId ?? null)
  )
  return connectionIds.size === 1 ? ([...connectionIds][0] ?? null) : undefined
}
