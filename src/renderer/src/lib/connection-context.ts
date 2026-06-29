import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../shared/cross-platform-path'
import {
  getFolderWorkspaceCandidateRepos,
  getFolderWorkspaceConnectionId
} from './folder-workspace-connection'

/**
 * Resolve the SSH connectionId for a worktree. Returns null for local repos,
 * the target ID string for remote repos, or undefined if the worktree/repo
 * cannot be found (e.g., store not yet hydrated).
 */
export function getConnectionId(worktreeId: string | null): string | null | undefined {
  return getConnectionIdFromState(useAppStore.getState(), worktreeId)
}

export function getConnectionIdFromState(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string | null
): string | null | undefined {
  if (!worktreeId) {
    return null
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId)
  }
  const allWorktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  const worktree = allWorktrees.find((w) => w.id === worktreeId)
  // Why: SSH worktrees can be restored from session IDs before relay discovery
  // repopulates worktreesByRepo. The composite ID still carries the repo ID.
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos?.find((r) => r.id === repoId)
  if (!repo) {
    return undefined
  }
  return repo.connectionId ?? null
}

/**
 * True when we can determine the owning host (local vs. a specific SSH target)
 * for a worktree. False means the backing repo has not landed in the store yet
 * — e.g. right after a session restore while the SSH connection is still
 * establishing. Callers must not fall back to a LOCAL read of a remote path in
 * that window; doing so denies the path with a terminal "access denied" (#6648).
 */
export function isWorktreeConnectionResolved(worktreeId: string | null): boolean {
  if (!worktreeId) {
    return true
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    // Folder workspaces resolve per-file; treat them as resolved here and let
    // getConnectionIdForFile decide ownership for the concrete path.
    return true
  }
  // Why: getConnectionId returns undefined only when the backing repo is absent;
  // any found repo yields a string or null, so this mirrors "repo has hydrated".
  return getConnectionId(worktreeId) !== undefined
}

export function getConnectionIdForFile(
  worktreeId: string | null,
  filePath: string
): string | null | undefined {
  const connectionId = getConnectionId(worktreeId)
  if (connectionId !== undefined || !worktreeId) {
    return connectionId
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type !== 'folder') {
    return undefined
  }
  // Why: mixed local/SSH folder workspaces cannot pick one owner globally, but
  // a concrete file path can still belong unambiguously to a child repo.
  const state = useAppStore.getState()
  const candidateRepos = getFolderWorkspaceCandidateRepos(
    state,
    parsedWorkspaceKey.folderWorkspaceId
  )
  return resolveConnectionIdForRepoPath(candidateRepos, filePath)
}

function resolveConnectionIdForRepoPath(
  repos: readonly { path: string; connectionId?: string | null }[],
  filePath: string
): string | null | undefined {
  const matchingRepos = repos
    .filter((repo) => isPathInsideOrEqual(repo.path, filePath))
    .map((repo) => ({ repo, normalizedPath: normalizeRuntimePathForComparison(repo.path) }))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length)
  const longestPathLength = matchingRepos[0]?.normalizedPath.length
  if (!longestPathLength) {
    return undefined
  }
  // Why: containment normalizes separators/trailing slashes; ambiguity checks
  // need the same representation or equal repo roots can be hidden.
  const bestMatches = matchingRepos.filter(
    (candidate) => candidate.normalizedPath.length === longestPathLength
  )
  const connectionIds = new Set(bestMatches.map(({ repo }) => repo.connectionId ?? null))
  return connectionIds.size === 1 ? ([...connectionIds][0] ?? null) : undefined
}
