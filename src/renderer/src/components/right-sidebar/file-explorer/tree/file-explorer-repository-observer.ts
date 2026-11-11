import { retiredExplorerRepositorySources } from './file-explorer-repository-frontier'
import { forgetExplorerRepositoryPaths } from './file-explorer-repository-evidence'
import { createExplorerRepositoryValidation } from './file-explorer-repository-validation'
import {
  explorerRepositoryOwner,
  type ExplorerRepositoryDemand
} from './file-explorer-repository-paths'
import {
  discoverExplorerRepositories,
  repositoryDiscoveryDueAt
} from './file-explorer-repository-discovery'
import {
  createGitStatusRefreshScheduler,
  type GitStatusRefreshScheduler
} from '../../source-control/sync/git-status-refresh-scheduler'
import {
  createExplorerRepositorySource,
  explorerRepositorySnapshot,
  updateExplorerRepositoryDemand,
  EXPLORER_REPOSITORY_SCHEDULER_OPTIONS,
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
  private candidateIndex = new ExplorerRepositoryPathIndex()
  private sources = new Map<string, ExplorerRepositorySourceState>()
  private candidates = new Map<string, ExplorerRepositoryCandidate>()
  private invalidListings = new WeakSet<object>()
  private validations = new Map<string, ReturnType<typeof createExplorerRepositoryValidation>>()
  private evidence = new Map<string, object | undefined>()
  private queue = new ExplorerRepositoryReadQueue()
  private visible = false
  private disposed = false
  private generation = 0
  private demand: readonly string[] = []
  private discovery: GitStatusRefreshScheduler
  private snapshot: readonly ExplorerRepositorySource[] = []
  private discoveryRetryAt = -Infinity

  constructor(
    private read: ExplorerRepositoryRead,
    private publish: (sources: readonly ExplorerRepositorySource[]) => void,
    private supports: () => Promise<boolean> = async () => true
  ) {
    this.discovery = createGitStatusRefreshScheduler(
      async ({ reason, signal }) => {
        const generation = this.generation
        if (Date.now() < this.discoveryRetryAt) {
          return
        }
        const supported = await Promise.resolve()
          .then(() => this.supports())
          .catch(() => undefined)
        if (!this.current(generation, signal)) {
          return
        }
        if (supported !== true) {
          if (supported === false) {
            this.sources.forEach((_, path) => this.removeSource(path, false, true))
            this.emit()
          }
          this.discoveryRetryAt = Date.now() + 60_000
          return
        }
        await discoverExplorerRepositories(
          {
            candidates: () => this.candidates,
            hasSource: (path) => this.sources.has(path),
            evidence: this.evidence,
            validations: this.validations,
            invalidListings: this.invalidListings,
            current: () => this.current(generation, signal),
            read: this.read,
            discovered: (paths) => this.activateSources(paths.map((path) => this.addSource(path)))
          },
          reason,
          signal
        )
      },
      {
        ...EXPLORER_REPOSITORY_SCHEDULER_OPTIONS,
        nextSafetyAt: () =>
          Math.max(
            this.discoveryRetryAt,
            repositoryDiscoveryDueAt(this.candidates, this.sources, this.validations)
          )
      }
    )
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
    this.evidence.delete(path)
    this.validations.delete(path)
    if (absent) {
      const candidate = this.candidates.get(path)
      if (candidate?.listing) {
        this.invalidListings.add(candidate.listing)
      }
      this.evidence.set(path, candidate?.listing)
      const validation = createExplorerRepositoryValidation()
      validation.settle(true)
      this.validations.set(path, validation)
    }
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
    for (const [path, evidence] of this.evidence) {
      if (!next.has(path) || next.get(path)?.listing !== evidence) {
        this.evidence.delete(path)
        this.validations.delete(path)
      }
    }
    this.candidates = next
    this.candidateIndex.set(next.keys())
    const retired = retiredExplorerRepositorySources(this.sources, dependencies, retainedSubtrees)
    for (const path of retired) {
      this.removeSource(path, false, true)
    }
    if (retired.length) {
      this.setDemand()
      this.emit()
    }
    if (this.visible) {
      this.discovery.signal()
    }
  }

  setDemand(paths: readonly string[] = this.demand, partition?: ExplorerRepositoryDemand): void {
    this.demand = paths
    updateExplorerRepositoryDemand(this.sources, paths, this.visible, () => this.emit(), partition)
  }

  invalidate(path?: string, directory = false): void {
    if (path === undefined) {
      this.generation++
      this.evidence.clear()
      this.validations.clear()
      this.discoveryRetryAt = -Infinity
      for (const candidate of this.candidates.values()) {
        if (candidate.listing) {
          this.invalidListings.add(candidate.listing)
        }
      }
      this.discovery.pause()
      for (const source of this.sources.values()) {
        source.scheduler.pause()
        source.statusDirty = true
        source.proofRevision++
        source.proofRetryAt = -Infinity
        source.ignoredQueries.invalidate(this.visible)
      }
      if (this.visible) {
        this.discovery.resumeSafety()
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
        this.candidateIndex
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
      this.evidence.delete(path)
      this.validations.delete(path)
      const listing = this.candidates.get(path)?.listing
      if (listing) {
        this.invalidListings.add(listing)
      }
    }
    if (discoveryCandidates.size && this.visible) {
      this.discovery.signal()
    }
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      return
    }
    this.visible = visible
    this.queue.setVisible(visible)
    if (visible) {
      this.discovery.resumeSafety()
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
