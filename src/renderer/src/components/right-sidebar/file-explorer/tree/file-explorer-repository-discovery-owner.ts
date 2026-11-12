import { ExplorerRepositoryDiscoveryDebt } from './file-explorer-repository-discovery-debt'
import { ExplorerRepositoryPathIndex } from './file-explorer-repository-path-index'
import { discoverExplorerRepositories } from './file-explorer-repository-discovery'
import {
  createGitStatusRefreshScheduler,
  type GitStatusRefreshScheduler
} from '../../source-control/sync/git-status-refresh-scheduler'
import {
  EXPLORER_REPOSITORY_SCHEDULER_OPTIONS,
  type ExplorerRepositoryRead
} from './file-explorer-repository-source'
import type { ExplorerRepositoryCandidate } from './file-explorer-repository-observer'

type DiscoveryOwner = {
  read: ExplorerRepositoryRead
  supports: () => Promise<boolean>
  generation: () => number
  visible: () => boolean
  current: (generation: number, signal: AbortSignal) => boolean
  hasSource: (path: string) => boolean
  discovered: (paths: readonly string[]) => void
  unsupported: () => void
}

export class ExplorerRepositoryDiscovery {
  readonly candidates = new Map<string, ExplorerRepositoryCandidate>()
  readonly index = new ExplorerRepositoryPathIndex()
  readonly debt = new ExplorerRepositoryDiscoveryDebt()
  private invalidListings = new WeakSet<object>()
  private validations = new Map<string, object>()
  private capabilityPending = true
  private discoveryRetryAt = -Infinity
  private discoveryEnabled = false
  private scheduler: GitStatusRefreshScheduler

  constructor(private owner: DiscoveryOwner) {
    this.scheduler = createGitStatusRefreshScheduler(
      async ({ signal }) => {
        const generation = this.owner.generation()
        if (Date.now() < this.discoveryDueAt()) {
          return
        }
        const supported = await Promise.resolve()
          .then(() => this.owner.supports())
          .catch(() => undefined)
        if (!this.owner.current(generation, signal)) {
          return
        }
        if (supported !== true) {
          if (supported === false) {
            this.owner.unsupported()
          }
          this.capabilityPending = true
          this.discoveryRetryAt = Date.now() + 60_000
          return
        }
        this.capabilityPending = false
        this.discoveryRetryAt = -Infinity
        await discoverExplorerRepositories(
          {
            candidates: () => this.candidates,
            hasSource: this.owner.hasSource,
            debt: this.debt,
            validations: this.validations,
            invalidListings: this.invalidListings,
            current: () => this.owner.current(generation, signal),
            read: this.owner.read,
            discovered: this.owner.discovered
          },
          signal
        )
      },
      {
        ...EXPLORER_REPOSITORY_SCHEDULER_OPTIONS,
        nextSafetyAt: () => this.discoveryDueAt()
      }
    )
  }

  private discoveryDueAt(): number {
    return Math.min(
      this.capabilityPending ? this.discoveryRetryAt : Infinity,
      Math.max(this.discoveryRetryAt, this.debt.dueAt())
    )
  }

  wake(): void {
    if (!this.owner.visible() || this.discoveryDueAt() === Infinity) {
      return
    }
    if (this.discoveryEnabled) {
      this.scheduler.signal()
    } else {
      this.discoveryEnabled = true
      this.scheduler.resumeSafety()
    }
  }

  update(changes: ReadonlyMap<string, ExplorerRepositoryCandidate | undefined>): void {
    for (const [path, candidate] of changes) {
      const previous = this.candidates.get(path)
      if (!candidate) {
        this.candidates.delete(path)
        this.index.delete(path)
        this.validations.delete(path)
        this.debt.delete(path)
      } else {
        this.candidates.set(path, candidate)
        if (!previous) {
          this.index.add(path)
        }
        if (
          !previous ||
          previous.listing !== candidate.listing ||
          previous.marker !== candidate.marker
        ) {
          this.validations.delete(path)
          if (!this.owner.hasSource(path)) {
            this.debt.invalidate(path)
          }
        }
      }
    }
  }

  invalidate(path: string): void {
    const candidate = this.candidates.get(path)
    if (!candidate) {
      return
    }
    this.validations.delete(path)
    if (!this.owner.hasSource(path)) {
      this.debt.invalidate(path)
    }
    if (candidate.listing) {
      this.invalidListings.add(candidate.listing)
    }
  }

  forgetSource(path: string, absent: boolean): void {
    this.debt.delete(path)
    this.validations.delete(path)
    if (absent && this.candidates.has(path)) {
      const candidate = this.candidates.get(path)!
      if (candidate.listing) {
        this.invalidListings.add(candidate.listing)
      }
      this.validations.set(path, {})
    }
  }

  reset(): void {
    this.validations.clear()
    this.debt.clear()
    this.capabilityPending = true
    this.discoveryRetryAt = -Infinity
    for (const candidate of this.candidates.values()) {
      if (!this.owner.hasSource(candidate.path)) {
        this.debt.invalidate(candidate.path)
      }
      if (candidate.listing) {
        this.invalidListings.add(candidate.listing)
      }
    }
    this.pause()
  }

  pause(): void {
    this.discoveryEnabled = false
    this.scheduler.pause()
  }

  dispose(): void {
    this.scheduler.dispose()
  }
}
