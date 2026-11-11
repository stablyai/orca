import {
  explorerRepositoryDependencies,
  explorerRepositoryOwner
} from './file-explorer-repository-paths'
import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'
import type { ExplorerRepositoryCandidate } from './file-explorer-repository-observer'
import type { DirCache, FileExplorerOperationOwner } from './file-explorer-types'

function sameOwner(
  a: FileExplorerOperationOwner | undefined,
  b: FileExplorerOperationOwner
): boolean {
  if (a?.kind !== b.kind) {
    return false
  }
  switch (b.kind) {
    case 'ssh':
      return a.kind === 'ssh' && a.connectionId === b.connectionId
    case 'runtime':
      return (
        a.kind === 'runtime' &&
        a.environmentId === b.environmentId &&
        a.executionHostId === b.executionHostId
      )
    case 'local':
    case 'unresolved':
      return true
  }
}

export function buildExplorerRepositoryFrontier(
  root: string,
  displayRoot: string,
  dirCache: Readonly<Record<string, DirCache>>,
  expanded: ReadonlySet<string>,
  owner: FileExplorerOperationOwner,
  hasRootGitSource: boolean
) {
  const candidates = new Map<string, ExplorerRepositoryCandidate>()
  const dependencies: string[] = []
  const retainedSubtrees: string[] = []
  const visit = (path: string): void => {
    const relative = relativePathInsideRoot(root, path)
    if (relative === null) {
      return
    }
    const cache = dirCache[path]
    if (!cache || cache.error !== undefined || !sameOwner(cache.operationOwner, owner)) {
      retainedSubtrees.push(relative)
      return
    }
    if (cache.outsideProject) {
      return
    }
    if (cache.more) {
      retainedSubtrees.push(relative)
    }
    if (relative !== '' || !hasRootGitSource) {
      candidates.set(relative, { path: relative, marker: cache.repositoryMarker, listing: cache })
    }
    for (const child of cache.children) {
      if (child.outsideProject || child.isSymlink || !sameOwner(child.operationOwner, owner)) {
        continue
      }
      dependencies.push(child.relativePath)
      if (!child.isDirectory) {
        continue
      }
      const childCache = dirCache[child.path]
      candidates.set(child.relativePath, {
        path: child.relativePath,
        ...(childCache &&
        childCache.error === undefined &&
        sameOwner(childCache.operationOwner, owner)
          ? { marker: childCache.repositoryMarker, listing: childCache }
          : {})
      })
      if (expanded.has(child.path)) {
        visit(child.path)
      } else {
        retainedSubtrees.push(child.relativePath)
      }
    }
  }
  visit(displayRoot)
  return { candidates: [...candidates.values()], dependencies, retainedSubtrees }
}

export function retiredExplorerRepositorySources(
  sources: ReadonlyMap<string, unknown>,
  dependencies: readonly string[],
  retainedSubtrees: readonly string[]
): string[] {
  if (sources.size === 0) {
    return []
  }
  const retained = new Set(retainedSubtrees)
  const ancestors = explorerRepositoryDependencies(dependencies)
  return [...sources.keys()].filter(
    (path) =>
      path !== '' &&
      !ancestors.has(path) &&
      explorerRepositoryOwner(retained, `${path}/`) === undefined
  )
}
