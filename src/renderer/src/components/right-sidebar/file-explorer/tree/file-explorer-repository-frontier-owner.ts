import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'
import { ExplorerRepositoryFrontierSupport } from './file-explorer-repository-frontier-support'
import type { ExplorerRepositoryCandidate } from './file-explorer-repository-observer'
import type { DirCache, FileExplorerOperationOwner } from './file-explorer-types'

type Contribution = {
  dependencies: string[]
  retained: Set<string>
  directories: Map<string, string>
}
type FrontierConsumer = {
  apply: (
    candidates: ReadonlyMap<string, ExplorerRepositoryCandidate | undefined>,
    affectedPaths: readonly string[],
    retains: (path: string) => boolean
  ) => void
  invalidate: (path: string) => void
  resetProof: () => void
}

function sameOwner(
  a: FileExplorerOperationOwner | undefined,
  b: FileExplorerOperationOwner
): boolean {
  return (
    a?.kind === b.kind &&
    (b.kind === 'ssh'
      ? a.kind === 'ssh' && a.connectionId === b.connectionId
      : b.kind === 'runtime'
        ? a.kind === 'runtime' &&
          a.environmentId === b.environmentId &&
          a.executionHostId === b.executionHostId
        : true)
  )
}

/** Each reachable directory owns its direct contribution; hidden commits retain only path headers. */
export class ExplorerRepositoryFrontier {
  private current: Readonly<Record<string, DirCache>> = {}
  private consumed = this.current
  private dirty = new Set<string>()
  private reset = true
  private visible = false
  private displayRoot: string | null = null
  private expanded: ReadonlySet<string> = new Set()
  private consumedExpanded = this.expanded
  private hasRootGitSource = false
  private directories = new Map<string, Contribution>()
  private admitted = new Map<string, string>()
  private parents = new Map<string, string>()
  private candidates = new Map<string, ExplorerRepositoryCandidate>()
  private support = new ExplorerRepositoryFrontierSupport()
  private changes = new Map<string, ExplorerRepositoryCandidate | undefined>()
  private affected = new Set<string>()

  constructor(
    private root: string,
    private owner: FileExplorerOperationOwner,
    private consumer: FrontierConsumer
  ) {}

  setView(
    displayRoot: string | null,
    expanded: ReadonlySet<string>,
    hasRootGitSource: boolean
  ): void {
    this.reset ||= displayRoot !== this.displayRoot || hasRootGitSource !== this.hasRootGitSource
    this.displayRoot = displayRoot
    this.expanded = expanded
    this.hasRootGitSource = hasRootGitSource
    if (this.visible) {
      this.reconcile()
    }
  }

  commit(cache: Readonly<Record<string, DirCache>>, paths: readonly string[], reset = false): void {
    this.current = cache
    if (reset) {
      this.reset = true
      this.dirty.clear()
      this.consumer.resetProof()
    } else {
      for (const path of paths) {
        const relative = relativePathInsideRoot(this.root, path)
        if (relative !== null) {
          this.consumer.invalidate(relative)
        }
        if (this.consumed[path] === cache[path]) {
          this.dirty.delete(path)
        } else {
          this.dirty.add(path)
        }
      }
    }
    if (this.visible) {
      this.reconcile()
    }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (visible) {
      this.reconcile()
    }
  }

  snapshot() {
    return {
      candidates: [...this.candidates.values()],
      dependencies: [...this.support.dependencies.keys()],
      retainedSubtrees: [...this.support.retained.keys()]
    }
  }

  private reconcile(): void {
    if (this.reset) {
      for (const path of this.candidates.keys()) {
        this.changes.set(path, undefined)
      }
      this.candidates.clear()
      this.admitted.clear()
      this.parents.clear()
      this.directories.clear()
      this.support.reset()
      this.affected.add('')
      if (this.displayRoot) {
        this.replaceDirectory(this.displayRoot)
      }
      this.reset = false
    } else {
      for (const path of this.dirty) {
        this.refreshCandidate(path)
        if (this.directories.has(path)) {
          this.replaceDirectory(path)
        }
      }
      if (this.expanded !== this.consumedExpanded) {
        for (const path of this.consumedExpanded) {
          if (!this.expanded.has(path) && path !== this.displayRoot) {
            this.removeDirectory(path)
            const relative = this.admitted.get(path)
            if (relative !== undefined) {
              const contribution = this.directories.get(this.parents.get(path)!)
              if (contribution && !contribution.retained.has(relative)) {
                contribution.retained.add(relative)
                this.support.retain(relative, 1)
              }
            }
          }
        }
        for (const path of this.expanded) {
          if (!this.consumedExpanded.has(path) && this.admitted.has(path)) {
            const relative = this.admitted.get(path)!
            if (this.directories.get(this.parents.get(path)!)?.retained.delete(relative)) {
              this.support.retain(relative, -1)
            }
            if (!this.directories.has(path)) {
              this.replaceDirectory(path)
            }
          }
        }
      }
    }
    this.consumed = this.current
    this.consumedExpanded = this.expanded
    this.dirty.clear()
    for (const path of this.support.changedRanges()) {
      this.affected.add(path)
    }
    if (this.changes.size || this.affected.size) {
      this.consumer.apply(this.changes, [...this.affected], (path) => this.support.retains(path))
      this.changes.clear()
      this.affected.clear()
    }
  }

  private valid(cache: DirCache | undefined): cache is DirCache {
    return !!cache && cache.error === undefined && sameOwner(cache.operationOwner, this.owner)
  }

  private refreshCandidate(path: string): void {
    const cache = this.current[path]
    const ownRelative = relativePathInsideRoot(this.root, path)
    const ownRoot = path === this.displayRoot && this.valid(cache) && !cache.outsideProject
    const relative =
      this.admitted.get(path) ??
      (ownRoot && (ownRelative !== '' || !this.hasRootGitSource) ? ownRelative : undefined)
    if (relative === undefined || relative === null) {
      if (path === this.displayRoot) {
        const old = relativePathInsideRoot(this.root, path)
        if (old !== null) {
          this.removeCandidate(old)
        }
      }
      return
    }
    const candidate: ExplorerRepositoryCandidate = {
      path: relative,
      ...(this.valid(cache) ? { listing: cache, marker: cache.repositoryMarker } : {})
    }
    const previous = this.candidates.get(relative)
    if (
      !previous ||
      previous.listing !== candidate.listing ||
      previous.marker !== candidate.marker
    ) {
      this.candidates.set(relative, candidate)
      this.changes.set(relative, candidate)
    }
  }

  private removeCandidate(path: string): void {
    if (this.candidates.delete(path)) {
      this.changes.set(path, undefined)
    }
  }

  private replaceDirectory(path: string): void {
    const relative = relativePathInsideRoot(this.root, path)
    if (relative === null) {
      return
    }
    const cache = this.current[path]
    const next: Contribution = { dependencies: [], retained: new Set(), directories: new Map() }
    if (!this.valid(cache)) {
      next.retained.add(relative)
    } else if (!cache.outsideProject) {
      if (cache.more) {
        next.retained.add(relative)
      }
      for (const child of cache.children) {
        if (
          child.outsideProject ||
          child.isSymlink ||
          !sameOwner(child.operationOwner, this.owner)
        ) {
          continue
        }
        next.dependencies.push(child.relativePath)
        if (child.isDirectory) {
          next.directories.set(child.path, child.relativePath)
          if (!this.expanded.has(child.path)) {
            next.retained.add(child.relativePath)
          }
        }
      }
    }
    const previous = this.directories.get(path)
    for (const dependency of previous?.dependencies ?? []) {
      this.support.dependency(dependency, -1)
    }
    for (const retained of previous?.retained ?? []) {
      this.support.retain(retained, -1)
    }
    for (const dependency of next.dependencies) {
      this.support.dependency(dependency, 1)
    }
    for (const retained of next.retained) {
      this.support.retain(retained, 1)
    }
    this.directories.set(path, next)
    this.refreshCandidate(path)
    for (const [child, relative] of previous?.directories ?? []) {
      if (!next.directories.has(child)) {
        this.admitted.delete(child)
        this.parents.delete(child)
        this.removeCandidate(relative)
        this.removeDirectory(child)
      }
    }
    for (const [child, relative] of next.directories) {
      this.admitted.set(child, relative)
      this.parents.set(child, path)
      this.refreshCandidate(child)
      if (this.expanded.has(child)) {
        if (!this.directories.has(child)) {
          this.replaceDirectory(child)
        }
      } else {
        this.removeDirectory(child)
      }
    }
  }

  private removeDirectory(path: string): void {
    const contribution = this.directories.get(path)
    if (!contribution) {
      return
    }
    this.directories.delete(path)
    for (const dependency of contribution.dependencies) {
      this.support.dependency(dependency, -1)
    }
    for (const retained of contribution.retained) {
      this.support.retain(retained, -1)
    }
    for (const [child, relative] of contribution.directories) {
      this.admitted.delete(child)
      this.parents.delete(child)
      this.removeCandidate(relative)
      this.removeDirectory(child)
    }
  }
}
