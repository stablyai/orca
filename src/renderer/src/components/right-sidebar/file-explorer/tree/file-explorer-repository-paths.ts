export function explorerRepositoryOwner(
  roots: { has: (path: string) => boolean },
  path: string
): string | undefined {
  let parent = path
  for (;;) {
    const slash = parent.lastIndexOf('/')
    parent = slash === -1 ? '' : parent.slice(0, slash)
    if (roots.has(parent)) {
      return parent
    }
    if (parent === '') {
      return undefined
    }
  }
}

export function explorerRepositoryDependencies(
  dependencies: readonly string[]
): ReadonlySet<string> {
  const ancestors = new Set<string>()
  for (const dependency of dependencies) {
    let path = dependency
    while (path) {
      if (ancestors.has(path)) {
        break
      }
      ancestors.add(path)
      const slash = path.lastIndexOf('/')
      path = slash === -1 ? '' : path.slice(0, slash)
    }
  }

  return ancestors
}

export type ExplorerRepositoryDemand = {
  rootPaths: readonly string[]
  byRepository: ReadonlyMap<string, readonly string[]>
}

export function partitionExplorerRepositoryDemand(
  roots: { size: number; has: (path: string) => boolean },
  paths: readonly string[]
): ExplorerRepositoryDemand {
  if (roots.size === 0) {
    return { rootPaths: paths, byRepository: new Map() }
  }
  const rootPaths: string[] = []
  const byRepository = new Map<string, string[]>()
  for (const path of paths) {
    const owner = explorerRepositoryOwner(roots, path)
    if (owner === undefined) {
      rootPaths.push(path)
    } else {
      const query = byRepository.get(owner) ?? []
      query.push(owner ? path.slice(owner.length + 1) : path)
      byRepository.set(owner, query)
    }
  }
  return { rootPaths, byRepository }
}
