import type { AppState } from '@/store/types'
import {
  findIndexedRepoOwnerForHost,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import { resolveWorktreeExecutionHost } from '../../../shared/worktree-execution-host-resolution'
import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
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
  selectFolderWorkspaces,
  selectWorkspaceByHostTarget,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { resolveQualifiedWorktreeExecutionOwner } from './qualified-worktree-execution-owner'

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
      previousSlices?.folderWorkspaces === selectFolderWorkspaces(state) &&
      previousSlices.projectGroups === state.projectGroups &&
      previousSlices.repos === state.repos &&
      selectWorktreesByRepo(previousSlices) === selectWorktreesByRepo(state)
    ) {
      return previousResult
    }
    previousSlices = {
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: selectWorktreesByRepo(state)
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
  // Retained selectors need indexed ownership; unrelated writes must not rescan every repo/worktree.
  const worktreeResolution = resolveIndexedWorktreeOwner(selectWorktreesByRepo(state), worktreeId)
  if (worktreeResolution.kind === 'ambiguous') {
    // Conflicting owners yield undefined, never null: null would authorize local reads of a remote path (#17799).
    return undefined
  }
  const worktree = worktreeResolution.kind === 'resolved' ? worktreeResolution.owner : undefined
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  // Share main’s scope rule; the renderer adds memoized indexing to avoid unrelated-write scans (#17799, #11163).
  const resolution = resolveWorktreeExecutionHost(
    {
      byId: (id) => resolveIndexedRepoOwner(state.repos, id),
      byHost: (id, hostId) => findIndexedRepoOwnerForHost(state.repos, id, hostId)
    },
    { repoId, hostId: worktree?.hostId ?? null }
  )
  return resolution.kind === 'resolved' ? resolution.connectionId : undefined
}

/** Resolve a directly named repo independently of pending/disagreeing workspace rows; undefined means the repo itself is absent. */
export function getRepoConnectionIdFromState(
  state: ConnectionOwnerState,
  repoId: string | null | undefined
): string | null | undefined {
  if (!repoId) {
    return undefined
  }
  const resolution = resolveIndexedRepoOwner(state.repos, repoId)
  return resolution.kind === 'resolved' ? getRepoSshConnectionId(resolution.owner) : undefined
}

export function getConnectionIdForFileFromState(
  state: ConnectionOwnerState,
  worktreeId: string | null,
  filePath: string
): string | null | undefined {
  return getFileConnectionOwnerFromState(state, worktreeId, filePath)?.connectionId
}

export function getFileConnectionOwnerFromState(
  state: ConnectionOwnerState,
  worktreeId: string | null,
  filePath: string
): { connectionId: string | null; repo?: Repo } | undefined {
  const connectionId = getConnectionIdFromState(state, worktreeId)
  if (connectionId !== undefined || !worktreeId) {
    return connectionId === undefined ? undefined : { connectionId }
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type !== 'folder') {
    return undefined
  }
  return getFolderFileConnectionOwnerFromState(
    state,
    parsedWorkspaceKey.folderWorkspaceId,
    filePath
  )
}

/** Path-specific child ownership remains meaningful when sibling removal resolves the whole folder. */
export function getFolderFileConnectionOwnerFromState(
  state: ConnectionOwnerState,
  folderWorkspaceId: string,
  filePath: string
): { connectionId: string | null; repo?: Repo } | undefined {
  const candidateRepos = getFolderWorkspaceCandidateRepos(state, folderWorkspaceId)
  const matchingRepos = candidateRepos
    .filter((repo) => isPathInsideOrEqual(repo.path, filePath))
    .map((repo) => ({ repo, normalizedPath: normalizeRuntimePathForComparison(repo.path) }))
    .sort((left, right) => right.normalizedPath.length - left.normalizedPath.length)
  const longestPathLength = matchingRepos[0]?.normalizedPath.length
  if (!longestPathLength) {
    return undefined
  }
  const longest = matchingRepos.filter(
    (candidate) => candidate.normalizedPath.length === longestPathLength
  )
  const owners = new Set(
    longest.map(({ repo }) =>
      JSON.stringify([getRepoExecutionHostId(repo), getRepoSshConnectionId(repo)])
    )
  )
  const repo = longest[0]?.repo
  return owners.size === 1 && repo
    ? { connectionId: getRepoSshConnectionId(repo), repo }
    : undefined
}

/**
 * The SSH connectionId of one host's copy of `worktreeId`. Ids repeat across hosts, so the bare-id
 * lookup above answers `undefined` for a same-path twin; naming the copy's host resolves it.
 */
export function getConnectionIdForWorktreeCopy(
  state: ConnectionOwnerState,
  worktreeId: string,
  hostId: ExecutionHostId
): string | null | undefined {
  if (parseWorkspaceKey(worktreeId)?.type !== 'folder') {
    return resolveQualifiedWorktreeExecutionOwner(
      selectWorktreesByRepo(state),
      state.repos,
      worktreeId,
      hostId
    )?.connectionId
  }
  const row = selectWorkspaceByHostTarget(
    {
      worktreesByRepo: selectWorktreesByRepo(state),
      folderWorkspaces: selectFolderWorkspaces(state)
    },
    hostWorktreeTarget({ id: worktreeId, hostId })
  )
  if (!row) {
    return undefined
  }
  const resolution = resolveWorktreeExecutionHost(
    {
      byId: (id) => resolveIndexedRepoOwner(state.repos, id),
      byHost: (id, repoHostId) => findIndexedRepoOwnerForHost(state.repos, id, repoHostId)
    },
    { repoId: row.repoId, hostId: row.hostId ?? hostId }
  )
  return resolution.kind === 'resolved' ? resolution.connectionId : undefined
}
