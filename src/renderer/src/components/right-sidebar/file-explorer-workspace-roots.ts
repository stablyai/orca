import { basename, joinPath, normalizeRelativePath } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { DirEntry } from '../../../../shared/types'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isPathInsideOrEqual, relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import type { FileExplorerRoot, TreeNode } from './file-explorer-types'
import { splitPathSegments } from './path-tree'
import { shouldIncludeFileExplorerEntry } from './file-explorer-entries'

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

export function createRootedFileExplorerChildren(
  entries: DirEntry[],
  dirPath: string,
  depth: number,
  root: FileExplorerRoot | null,
  rootPath: string | null
): TreeNode[] {
  return entries.filter(shouldIncludeFileExplorerEntry).map((entry) => {
    const path = joinPath(dirPath, entry.name)
    return {
      name: entry.name,
      path,
      relativePath: getRelativePathForRoot(rootPath, path, entry.name),
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      depth: depth + 1,
      rootId: root?.id,
      rootName: root?.name,
      rootPath: root?.path,
      rootWorktreeId: root?.worktreeId,
      rootRepoId: root?.repoId,
      rootConnectionId: root?.connectionId,
      rootRuntimeEnvironmentId: root?.runtimeEnvironmentId
    }
  })
}

export function createWorkspaceRootNode(root: FileExplorerRoot): TreeNode {
  return {
    name: root.name,
    path: root.path,
    relativePath: '',
    isDirectory: true,
    depth: 0,
    rootId: root.id,
    rootName: root.name,
    rootPath: root.path,
    rootWorktreeId: root.worktreeId,
    rootRepoId: root.repoId,
    rootConnectionId: root.connectionId,
    rootRuntimeEnvironmentId: root.runtimeEnvironmentId,
    isWorkspaceRoot: true
  }
}

export function resolveRootContext(
  roots: readonly FileExplorerRoot[],
  path: string,
  fallbackWorktreePath: string | null,
  fallbackWorktreeId?: string | null
): {
  root: FileExplorerRoot | null
  worktreeId: string | null
  worktreePath: string | null
  connectionId: string | undefined
} {
  const root = findRootForPath(roots, path, fallbackWorktreePath, fallbackWorktreeId)
  const worktreeId = root?.worktreeId ?? fallbackWorktreeId ?? null
  const worktreePath = root?.path ?? fallbackWorktreePath
  // Why: synthetic fallback roots omit connectionId, but an explicit null root
  // is local and must not fall back to the active/derived repo connection.
  const connectionId =
    root?.connectionId !== undefined
      ? (root.connectionId ?? undefined)
      : (getConnectionId(worktreeId ?? null) ?? undefined)
  return { root, worktreeId, worktreePath, connectionId }
}

export function findRootForPath(
  roots: readonly FileExplorerRoot[],
  path: string,
  fallbackWorktreePath: string | null,
  fallbackWorktreeId?: string | null
): FileExplorerRoot | null {
  const candidates =
    roots.length > 0 ? roots : createFallbackRoots(fallbackWorktreePath, fallbackWorktreeId)
  let best: FileExplorerRoot | null = null
  for (const root of candidates) {
    if (!isPathInsideOrEqual(root.path, path)) {
      continue
    }
    if (!best || root.path.length > best.path.length) {
      best = root
    }
  }
  return best
}

function createFallbackRoots(
  worktreePath: string | null,
  worktreeId?: string | null
): FileExplorerRoot[] {
  // Why: single-root callers do not pass workspace roots, but the lookup code
  // still needs a synthetic root to share the multi-root resolution path.
  if (!worktreePath || !worktreeId) {
    return []
  }
  return [
    {
      id: worktreeId,
      name: worktreePath,
      path: worktreePath,
      worktreeId,
      repoId: '',
      isActive: true
    }
  ]
}

export function getRelativePathForRoot(
  rootPath: string | null | undefined,
  filePath: string,
  fallbackName: string
): string {
  if (!rootPath) {
    return fallbackName
  }
  return normalizeRelativePath(relativePathInsideRoot(rootPath, filePath) ?? fallbackName)
}

export function getDirectoryNodeDepth(relativePath: string, hasMultipleRoots: boolean): number {
  const segmentCount = splitPathSegments(relativePath).length
  // Why: in multi-root mode the virtual workspace root consumes depth 0.
  return hasMultipleRoots ? segmentCount : segmentCount - 1
}
