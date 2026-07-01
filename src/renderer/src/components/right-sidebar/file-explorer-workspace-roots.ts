import { basename } from '@/lib/path'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import type { FileExplorerRoot, TreeNode } from './file-explorer-types'

type FileExplorerWorkspaceRootState = Pick<
  AppState,
  'projectGroups' | 'repos' | 'settings' | 'worktreesByRepo'
>

function findWorktree(
  worktreesByRepo: AppState['worktreesByRepo'],
  worktreeId: string
): AppState['worktreesByRepo'][string][number] | null {
  for (const worktrees of Object.values(worktreesByRepo)) {
    const match = worktrees.find((worktree) => worktree.id === worktreeId)
    if (match) {
      return match
    }
  }
  return null
}

function chooseRepoRootWorktree(
  state: FileExplorerWorkspaceRootState,
  repoId: string,
  activeWorktreeId: string
): AppState['worktreesByRepo'][string][number] | null {
  const worktrees = state.worktreesByRepo[repoId] ?? []
  const active = worktrees.find((worktree) => worktree.id === activeWorktreeId)
  if (active) {
    return active
  }
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? worktrees[0] ?? null
}

function getUniqueRootNames(
  roots: readonly Pick<FileExplorerRoot, 'id' | 'name' | 'path'>[]
): Map<string, string> {
  const rootsByName = new Map<string, Pick<FileExplorerRoot, 'id' | 'name' | 'path'>[]>()
  for (const root of roots) {
    rootsByName.set(root.name, [...(rootsByName.get(root.name) ?? []), root])
  }

  const names = new Map<string, string>()
  for (const [name, namedRoots] of rootsByName.entries()) {
    if (namedRoots.length === 1) {
      names.set(namedRoots[0].id, name)
      continue
    }
    for (const root of namedRoots) {
      names.set(root.id, `${name} - ${root.path}`)
    }
  }
  return names
}

export function getFileExplorerWorkspaceRoots(
  state: FileExplorerWorkspaceRootState,
  activeWorktreeId: string | null
): FileExplorerRoot[] {
  if (!activeWorktreeId) {
    return []
  }

  const activeWorktree = findWorktree(state.worktreesByRepo, activeWorktreeId)
  if (!activeWorktree) {
    return []
  }

  const activeRepo = state.repos.find((repo) => repo.id === activeWorktree.repoId)
  if (!activeRepo) {
    return []
  }

  const groupIds = activeRepo.projectGroupId
    ? getProjectGroupSubtreeIds(state.projectGroups, activeRepo.projectGroupId)
    : null
  const candidateRepos = groupIds
    ? state.repos.filter((repo) => groupIds.has(repo.projectGroupId ?? ''))
    : [activeRepo]

  const roots = candidateRepos
    .map((repo): FileExplorerRoot | null => {
      const worktree = chooseRepoRootWorktree(state, repo.id, activeWorktreeId)
      if (!worktree?.path) {
        return null
      }
      return {
        id: worktree.id,
        name: repo.displayName || worktree.displayName || basename(worktree.path),
        path: worktree.path,
        worktreeId: worktree.id,
        repoId: repo.id,
        connectionId: repo.connectionId ?? null,
        runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktree.id),
        isActive: worktree.id === activeWorktreeId
      }
    })
    .filter((root): root is FileExplorerRoot => root !== null)

  const uniqueNames = getUniqueRootNames(roots)
  return roots.map((root) => ({ ...root, name: uniqueNames.get(root.id) ?? root.name }))
}

export function getNodeFileExplorerRoot(
  roots: readonly FileExplorerRoot[],
  node: Pick<TreeNode, 'rootId' | 'rootPath' | 'rootWorktreeId' | 'path'>
): FileExplorerRoot | null {
  const explicitRoot =
    (node.rootId ? roots.find((root) => root.id === node.rootId) : null) ??
    (node.rootWorktreeId ? roots.find((root) => root.worktreeId === node.rootWorktreeId) : null)
  if (explicitRoot) {
    return explicitRoot
  }
  return roots.find((root) => root.path === node.rootPath || root.path === node.path) ?? null
}

export function getFileExplorerRootForPath(
  roots: readonly FileExplorerRoot[],
  path: string,
  fallbackRoot?: FileExplorerRoot | null
): FileExplorerRoot | null {
  let bestRoot: FileExplorerRoot | null = null
  for (const root of roots) {
    if (!isPathInsideOrEqual(root.path, path)) {
      continue
    }
    if (!bestRoot || root.path.length > bestRoot.path.length) {
      bestRoot = root
    }
  }
  return bestRoot ?? fallbackRoot ?? null
}
