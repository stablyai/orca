import { explorerRepositoryOwner } from './file-explorer-repository-paths'
import type { FsChangeEvent } from '../../../../../../shared/file-watch/filesystem-change-event'

export type ExplorerRepositoryChange = {
  path: string
  directory?: boolean
  kind: Exclude<FsChangeEvent['kind'], 'overflow'>
}
/** Membership changes rebuild the sorted index lazily; event batches only visit matching ranges. */
export class ExplorerRepositoryPathIndex {
  private paths = new Set<string>()
  private sorted: readonly string[] | null = null

  add(path: string): void {
    if (!this.paths.has(path)) {
      this.paths.add(path)
      this.sorted = null
    }
  }

  delete(path: string): void {
    if (this.paths.delete(path)) {
      this.sorted = null
    }
  }

  set(paths: Iterable<string>): void {
    const next = new Set(paths)
    if (next.size !== this.paths.size || [...next].some((path) => !this.paths.has(path))) {
      this.paths = next
      this.sorted = null
    }
  }

  descendants(paths: readonly string[]): Set<string> {
    const sorted = (this.sorted ??= [...this.paths].sort())
    const lowerBound = (target: string): number => {
      let low = 0
      let high = sorted.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (sorted[middle] < target) {
          low = middle + 1
        } else {
          high = middle
        }
      }
      return low
    }
    const ranges: [number, number][] = []
    for (const path of new Set(paths)) {
      const exact = lowerBound(path)
      if (sorted[exact] === path) {
        ranges.push([exact, exact + 1])
      }
      ranges.push([
        lowerBound(path ? `${path}/` : ''),
        path ? lowerBound(`${path}0`) : sorted.length
      ])
    }
    const found = new Set<string>()
    let visitedUntil = 0
    for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
      for (let index = Math.max(start, visitedUntil); index < end; index++) {
        found.add(sorted[index])
      }
      visitedUntil = Math.max(visitedUntil, end)
    }
    return found
  }

  related(paths: readonly string[]): Set<string> {
    const found = this.descendants(paths)
    for (let path of paths) {
      for (;;) {
        if (this.paths.has(path)) {
          found.add(path)
        }
        if (!path) {
          break
        }
        const slash = path.lastIndexOf('/')
        path = slash === -1 ? '' : path.slice(0, slash)
      }
    }
    return found
  }
}

export function collectExplorerRepositoryInvalidation(
  changes: readonly ExplorerRepositoryChange[],
  sources: ReadonlyMap<string, unknown>,
  sourceIndex: ExplorerRepositoryPathIndex,
  candidateIndex: ExplorerRepositoryPathIndex
) {
  const directories = changes.filter((change) => change.directory || change.kind !== 'update')
  const affected = sourceIndex.descendants(directories.map((change) => change.path))
  const proofOwners = sourceIndex.descendants(
    changes.filter((change) => change.kind !== 'update').map((change) => change.path)
  )
  const ignoreOwners = new Set<string | undefined>(proofOwners)
  for (const { path } of changes) {
    const owner = explorerRepositoryOwner(sources, `${path}/`)
    if (owner !== undefined) {
      affected.add(owner)
    }
    const marker = /(?:^|\/)\.git(?:\/|$)/.exec(path)
    const proofRoot = marker ? path.slice(0, marker.index) : undefined
    if (proofRoot !== undefined && sources.has(proofRoot)) {
      proofOwners.add(proofRoot)
      ignoreOwners.add(proofRoot)
    }
    if (path.endsWith('/.gitignore') || path === '.gitignore' || path.includes('/.git/')) {
      ignoreOwners.add(owner)
    }
  }
  const discoveryPaths = changes
    .filter(
      (change) =>
        change.directory ||
        change.deleted ||
        change.path.endsWith('/.git') ||
        change.path === '.git'
    )
    .map((change) => change.path)
  return {
    affected,
    proofOwners,
    ignoreOwners,
    deleted: new Set(
      changes.filter((change) => change.kind === 'delete').map((change) => change.path)
    ),
    discoveryCandidates: candidateIndex.related(discoveryPaths)
  }
}
