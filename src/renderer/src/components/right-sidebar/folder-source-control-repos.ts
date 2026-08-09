import type {
  FolderWorkspace,
  NestedRepoCandidate,
  ProjectGroup,
  Repo
} from '../../../../shared/types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getFolderWorkspaceCandidateRepos } from '@/lib/folder-workspace-connection'

type FolderSourceControlState = {
  folderWorkspaces?: readonly FolderWorkspace[]
  projectGroups?: readonly ProjectGroup[]
  repos?: readonly Repo[]
}

type FolderRepoTarget = Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> & {
  projectGroupId?: string | null
}

export type FolderGitTarget = {
  key: string
  path: string
  displayName: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  repo?: Repo | null
}

function sameExecutionHost(repo: Repo, targetHostId: string): boolean {
  return getRepoExecutionHostId(repo) === targetHostId
}

function filterFolderRepoCandidates(args: {
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  target: FolderRepoTarget
  connectionId: string | null
}): Repo[] {
  const targetHostId = getRepoExecutionHostId(args.target)
  const groupIds = args.target.projectGroupId
    ? getProjectGroupSubtreeIds(args.projectGroups, args.target.projectGroupId)
    : new Set<string>()
  const groupRepos = args.repos.filter(
    (repo) =>
      repo.id !== args.target.id &&
      isGitRepoKind(repo) &&
      typeof repo.projectGroupId === 'string' &&
      groupIds.has(repo.projectGroupId) &&
      isPathInsideOrEqual(args.target.path, repo.path) &&
      sameExecutionHost(repo, targetHostId)
  )
  const pathRepos = args.repos.filter(
    (repo) =>
      repo.id !== args.target.id &&
      isGitRepoKind(repo) &&
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(args.target.path, repo.path) &&
      sameExecutionHost(repo, targetHostId)
  )
  if (args.connectionId) {
    return [...groupRepos, ...pathRepos].filter((repo) => repo.connectionId === args.connectionId)
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  const groupConnectionIds = new Set(groupRepos.map((repo) => repo.connectionId ?? null))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(repo.connectionId ?? null))
  ]
}

export function selectFolderSourceControlRepos(
  state: FolderSourceControlState,
  activeWorktreeId: string | null | undefined,
  activeFolderRepo: FolderRepoTarget | null | undefined
): Repo[] {
  const workspaceScope = parseWorkspaceKey(activeWorktreeId ?? '')
  if (workspaceScope?.type === 'folder') {
    return getFolderWorkspaceCandidateRepos(
      {
        folderWorkspaces: [...(state.folderWorkspaces ?? [])],
        projectGroups: [...(state.projectGroups ?? [])],
        repos: [...(state.repos ?? [])]
      },
      workspaceScope.folderWorkspaceId
    ).filter(isGitRepoKind)
  }
  if (!activeFolderRepo) {
    return []
  }
  return filterFolderRepoCandidates({
    repos: state.repos ?? [],
    projectGroups: state.projectGroups ?? [],
    target: activeFolderRepo,
    connectionId: activeFolderRepo.connectionId ?? null
  })
}

export function mergeFolderGitTargets(args: {
  repos: readonly Repo[]
  scannedRepos: readonly NestedRepoCandidate[]
  parentPath: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}): FolderGitTarget[] {
  const knownPaths = new Set(args.repos.map((repo) => normalizeRuntimePathForComparison(repo.path)))
  const targets: FolderGitTarget[] = args.repos.map((repo) => ({
    key: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    connectionId: repo.connectionId,
    executionHostId: repo.executionHostId,
    repo
  }))

  for (const scanned of args.scannedRepos) {
    const normalizedScannedPath = normalizeRuntimePathForComparison(scanned.path)
    if (
      !isPathInsideOrEqual(args.parentPath, scanned.path) ||
      knownPaths.has(normalizedScannedPath)
    ) {
      continue
    }
    knownPaths.add(normalizedScannedPath)
    targets.push({
      key: `path:${scanned.path}`,
      path: scanned.path,
      displayName: scanned.displayName,
      connectionId: args.connectionId,
      executionHostId: args.executionHostId,
      repo: null
    })
  }
  return targets
}
