import { retiredExplorerRepositorySources } from './file-explorer-repository-frontier'
import { forgetExplorerRepositoryPaths } from './file-explorer-repository-evidence'
import { ExplorerRepositoryDiscovery } from './file-explorer-repository-discovery-owner'
import {
  explorerRepositoryOwner,
  type ExplorerRepositoryDemand
} from './file-explorer-repository-paths'
import {
  createExplorerRepositorySource,
  explorerRepositorySnapshot,
  updateExplorerRepositoryDemand,
  type ExplorerRepositorySource,
  type ExplorerRepositorySourceState,
  type ExplorerRepositoryRead
} from './file-explorer-repository-source'
import { ExplorerRepositoryReadQueue } from './file-explorer-repository-read-queue'
import {
  ExplorerRepositoryPathIndex,
  collectExplorerRepositoryInvalidation,
  type ExplorerRepositoryChange
} from './file-explorer-repository-path-index'

export { explorerRepositoryOwner } from './file-explorer-repository-paths'
export type { ExplorerRepositorySource } from './file-explorer-repository-source'
export type ExplorerRepositoryCandidate = { path: string; marker?: boolean; listing?: object }
export type { ExplorerRepositoryChange } from './file-explorer-repository-path-index'

/** One logical Explorer owns discovery and independent sources; virtual rows never own Git work. */
export class FileExplorerRepositoryObserver {
  private sourceIndex = new ExplorerRepositoryPathIndex()
  private sources = new Map<string, ExplorerRepositorySourceState>()
  private queue = new ExplorerRepositoryReadQueue()
  private visible = false
  private disposed = false
  private generation = 0
  private demand: readonly string[] = []
  private discovery: ExplorerRepositoryDiscovery
  private snapshot: readonly ExplorerRepositorySource[] = []

  constructor(
    private read: ExplorerRepositoryRead,
    private publish: (sources: readonly ExplorerRepositorySource[]) => void,
    supports: () => Promise<boolean> = async () => true
  ) {
    this.discovery = new ExplorerRepositoryDiscovery({
      read,
      supports,
      generation: () => this.generation,
      visible: () => this.visible,
      current: (generation, signal) => this.current(generation, signal),
      hasSource: (path) => this.sources.has(path),
      discovered: (paths) => this.activateSources(paths.map((path) => this.addSource(path))),
      unsupported: () => {
        this.sources.forEach((_, path) => {
          this.removeSource(path, false, true)
          this.discovery.invalidate(path)
        })
        this.emit()
      }
    })
  }

  private current(generation: number, signal: AbortSignal): boolean {
    return this.visible && !this.disposed && generation === this.generation && !signal.aborted
  }

  private emit(): void {
    const next = explorerRepositorySnapshot(this.sources.values(), this.snapshot)
    if (next !== this.snapshot) {
      this.snapshot = next
      this.publish(next)
    }
  }

  private addSource(path: string): ExplorerRepositorySourceState | undefined {
    if (this.sources.has(path)) {
      return
    }
    const source = createExplorerRepositorySource(path, {
      read: this.read,
      generation: () => this.generation,
      current: (candidate, generation = this.generation, signal) =>
        this.sources.get(path) === candidate &&
        this.visible &&
        !this.disposed &&
        generation === this.generation &&
        !signal?.aborted,
      admit: (key, signal, run) => this.queue.admit(key, signal, run),
      remove: () => this.removeSource(path, true),
      publish: () => this.emit()
    })
    this.discovery.debt.delete(path)
    this.sources.set(path, source)
    this.sourceIndex.add(path)
    return source
  }

  private activateSources(created: readonly (ExplorerRepositorySourceState | undefined)[]): void {
    if (!created.some(Boolean)) {
      return
    }
    this.setDemand()
    this.emit()
    if (this.visible) {
      for (const source of created) {
        source?.scheduler.resumeSafety()
      }
    }
  }

  private removeSource(path: string, absent = false, deferPublish = false): void {
    this.sources.get(path)?.scheduler.dispose()
    this.sources.delete(path)
    this.sourceIndex.delete(path)
    this.discovery.forgetSource(path, absent)
    if (!deferPublish) {
      this.setDemand()
      this.emit()
    }
  }

  setFrontier(
    candidates: readonly ExplorerRepositoryCandidate[],
    dependencies: readonly string[],
    retainedSubtrees: readonly string[] = dependencies
  ): void {
    const next = new Map(candidates.map((candidate) => [candidate.path, candidate]))
    const changes = new Map<string, ExplorerRepositoryCandidate | undefined>()
    for (const path of this.discovery.candidates.keys()) {
      if (!next.has(path)) {
        changes.set(path, undefined)
      }
    }
    for (const [path, candidate] of next) {
      changes.set(path, candidate)
    }
    this.discovery.update(changes)
    const retired = retiredExplorerRepositorySources(this.sources, dependencies, retainedSubtrees)
    for (const path of retired) {
      this.removeSource(path, false, true)
    }
    if (retired.length) {
      this.setDemand()
      this.emit()
    }
    this.discovery.wake()
  }

  updateFrontier(
    changes: ReadonlyMap<string, ExplorerRepositoryCandidate | undefined>,
    affectedPaths: readonly string[],
    retains: (path: string) => boolean
  ): void {
    this.discovery.update(changes)
    let retired = false
    for (const path of this.sourceIndex.related(affectedPaths)) {
      if (path !== '' && !retains(path)) {
        this.removeSource(path, false, true)
        retired = true
      }
    }
    if (retired) {
      this.setDemand()
      this.emit()
    }
    if (this.discovery.debt.dueAt() <= Date.now()) {
      this.discovery.wake()
    }
  }

  invalidateCandidate(path: string): void {
    this.discovery.invalidate(path)
  }

  setDemand(paths: readonly string[] = this.demand, partition?: ExplorerRepositoryDemand): void {
    this.demand = paths
    updateExplorerRepositoryDemand(this.sources, paths, this.visible, () => this.emit(), partition)
  }

  invalidate(path?: string, directory = false): void {
    if (path === undefined) {
      this.generation++
      this.discovery.reset()
      for (const source of this.sources.values()) {
        source.scheduler.pause()
        source.statusDirty = true
        source.proofRevision++
        source.proofRetryAt = -Infinity
        source.ignoredQueries.invalidate(this.visible)
      }
      if (this.visible) {
        this.discovery.wake()
        for (const source of this.sources.values()) {
          source.scheduler.resumeSafety()
        }
      }
      return
    }
    this.invalidateChanges([{ path, directory, kind: 'update' }])
  }

  invalidateChanges(changes: readonly ExplorerRepositoryChange[]): void {
    const { affected, proofOwners, ignoreOwners, deleted, discoveryCandidates } =
      collectExplorerRepositoryInvalidation(
        changes,
        this.sources,
        this.sourceIndex,
        this.discovery.index
      )
    let pruned = false
    for (const path of affected) {
      const source = this.sources.get(path)!
      if (deleted.size) {
        pruned =
          forgetExplorerRepositoryPaths(
            source,
            (path) => explorerRepositoryOwner(deleted, `${path}/`) !== undefined
          ) || pruned
      }
      source.statusDirty = true
      if (proofOwners.has(path)) {
        source.proofRevision++
        source.proofRetryAt = -Infinity
      }
      if (ignoreOwners.has(path)) {
        source.ignoredQueries.invalidate(this.visible)
      }
      if (this.visible) {
        source.scheduler.signal()
      }
    }
    if (pruned) {
      this.emit()
    }
    for (const path of discoveryCandidates) {
      this.discovery.invalidate(path)
    }
    if (discoveryCandidates.size && this.visible) {
      this.discovery.wake()
    }
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return
    }
    this.visible = visible
    this.queue.setVisible(visible)
    if (visible) {
      this.discovery.wake()
      for (const source of this.sources.values()) {
        source.statusDirty = true
        source.proofRevision++
        source.proofRetryAt = -Infinity
        source.ignoredQueries.invalidate(this.visible)
        source.scheduler.resumeSafety()
      }
    } else {
      this.discovery.pause()
      for (const source of this.sources.values()) {
        source.ignoredQueries.suspend()
        source.scheduler.pause()
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.discovery.dispose()
    for (const source of this.sources.values()) {
      source.scheduler.dispose()
    }
    this.queue.dispose()
  }
}
