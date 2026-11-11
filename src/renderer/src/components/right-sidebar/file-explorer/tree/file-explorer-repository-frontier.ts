import {
  explorerRepositoryDependencies,
  explorerRepositoryOwner
} from './file-explorer-repository-paths'
import { ExplorerRepositoryFrontier } from './file-explorer-repository-frontier-owner'
import type { DirCache, FileExplorerOperationOwner } from './file-explorer-types'

export function buildExplorerRepositoryFrontier(
  root: string,
  displayRoot: string,
  dirCache: Readonly<Record<string, DirCache>>,
  expanded: ReadonlySet<string>,
  owner: FileExplorerOperationOwner,
  hasRootGitSource: boolean
) {
  const frontier = new ExplorerRepositoryFrontier(root, owner, {
    apply: () => {},
    invalidate: () => {},
    resetProof: () => {},
    branches: () => [],
    invalidateSubtree: () => {}
  })
  frontier.setView(displayRoot, expanded, hasRootGitSource)
  frontier.commit(dirCache, [])
  frontier.setVisible(true)
  return frontier.snapshot()
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
