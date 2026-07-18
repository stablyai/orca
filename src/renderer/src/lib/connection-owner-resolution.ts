import type { AppState } from '@/store/types'
import type { PinnedTerminalPanel } from '../../../shared/types'
import type { SshTarget } from '../../../shared/ssh-types'
import { getIndexedRepoMap, getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import {
  getPinnedTerminalPanelHostForWorktreeId,
  isPinnedTerminalPanelWorktreeId,
  isSentinelWorktreeId,
  resolvePinnedTerminalPanelSshTargetId
} from '../../../shared/pinned-terminal-panels'
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

type ConnectionOwnerState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
> & {
  // Why: structural (not AppState['settings']) so narrow test states and
  // intersected caller state types don't have to satisfy full GlobalSettings.
  settings?: {
    pinnedTerminalPanels?: readonly PinnedTerminalPanel[]
    sshTargets?: readonly SshTarget[]
  } | null
}

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
  if (!worktreeId) {
    return null
  }
  if (isPinnedTerminalPanelWorktreeId(worktreeId)) {
    const panelHost = getPinnedTerminalPanelHostForWorktreeId(
      state.settings?.pinnedTerminalPanels,
      worktreeId
    )
    if (panelHost === null) {
      return null
    }
    // Why: undefined (not null) for an unresolvable host — null means "local",
    // and a panel pointed at a missing/typo'd SSH target must not silently run
    // its command on this machine (see isWorktreeConnectionResolved).
    return resolvePinnedTerminalPanelSshTargetId(state.settings?.sshTargets, panelHost) ?? undefined
  }
  if (isSentinelWorktreeId(worktreeId)) {
    return null
  }
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId)
  }
  // Why: owner resolution runs from retained Zustand selectors, so unrelated
  // store writes must not flatten every worktree or scan every repository.
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo).get(worktreeId)
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = getIndexedRepoMap(state.repos).get(repoId)
  return repo ? (repo.connectionId ?? null) : undefined
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
