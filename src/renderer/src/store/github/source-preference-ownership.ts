import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { CacheEntry } from './cache-model'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import { githubTaskBinding } from '@/lib/github-task-observation'
import { bindingKey, type BindingIncarnation, type TaskBinding } from './task-record-model'
import { isHostIdentityContinued } from '../host-catalog-fencing'
import { nextProviderRequestId } from './request-coordination'
import { createSourceWrite, waitForWriteEnd, type SourceWrite } from './source-write'

const unsafeTarget = () => false
/** What one recovery readback repairs: a failed write, or a contradicted binding incarnation. */
type RecoveryEpisode = SourceWrite | BindingIncarnation
export const githubCandidateOwner = (repo: Repo) =>
  githubTaskBinding({ ...repo, issueSourcePreference: undefined })
export const githubCollectionScope = (repo: Repo | undefined, source?: TaskSourceContext | null) =>
  JSON.stringify([repo && githubTaskBinding(repo), source && getTaskSourceCacheScope(source)])
export type CollectionOwner = {
  repo: Repo
  binding: TaskBinding | undefined
  id: number
  order: number
  /** Catalog rows read back after every source transition they could have missed. */
  readbacks: number
  candidates?: CacheEntry<readonly GitHubWorkItem[]>
}
export type Attempt = {
  owner: CollectionOwner | undefined
  /** The owner's lifetime id at capture; retirement replaces it, so only that owner's deliveries go obsolete. */
  context: number | undefined
  order: number
  repo: Repo | undefined
  binding: TaskBinding | undefined
  write: SourceWrite | undefined
  eligible: boolean
  scope: string
  source?: TaskSourceContext | null
}

/** Owns optimistic source writes and the repository/host lifetime they may publish into. */
export abstract class GitHubSourceOwnership {
  protected writes = new Map<string, SourceWrite>()
  protected owners = new Map<string, CollectionOwner>()
  private recoveries = new WeakMap<RecoveryEpisode, Promise<void>>()
  /** Shared by every catalog request until a write begins or settles or owners change; never mutated. */
  private snapshot?: Map<
    string,
    { owner: CollectionOwner; write: SourceWrite | undefined; pending: boolean }
  >
  constructor(protected store: StoreApi<AppState>) {}
  protected abstract reuse(repo: Repo, preference: Repo['issueSourcePreference']): void
  protected abstract retireOwners(owners: readonly CollectionOwner[]): void
  begin(repo: Repo, preference: Repo['issueSourcePreference']) {
    const previous = this.writes.get(bindingKey(repo))
    previous?.finish(false)
    const write = createSourceWrite({
      repo,
      owner: this.owners.get(bindingKey(repo)),
      preference,
      acknowledged: previous ? previous.acknowledged : repo.issueSourcePreference
    })
    this.writes.set(bindingKey(repo), write)
    this.snapshot = undefined
    this.reuse(repo, preference)
    return write
  }
  adopt(repo: Repo, started?: ReturnType<GitHubSourceOwnership['catalogSnapshot']>) {
    const key = bindingKey(repo)
    const owner = this.owners.get(key)
    const before = started?.get(key)
    const write = this.writes.get(key)
    // Why: a row read after every transition it could have missed is the host's authoritative source.
    if (
      owner &&
      before?.owner === owner &&
      before.write === write &&
      before.pending === (write?.pending ?? false)
    ) {
      owner.readbacks++
    }
    if (
      started &&
      owner &&
      before?.owner !== owner &&
      githubCandidateOwner(repo) === githubCandidateOwner(owner.repo)
    ) {
      return { ...repo, issueSourcePreference: owner.repo.issueSourcePreference }
    }
    if (!write || githubCandidateOwner(repo) !== githubCandidateOwner(write.repo)) {
      return repo
    }
    const stale = started && (before?.write !== write || before.pending !== write.pending)
    return write.pending || stale
      ? { ...repo, issueSourcePreference: write.pending ? write.preference : write.acknowledged }
      : repo
  }
  catalogSnapshot() {
    this.snapshot ??= new Map(
      [...this.owners].map(([key, owner]) => {
        const write = this.writes.get(key)
        return [key, { owner, write, pending: write?.pending ?? false }]
      })
    )
    return this.snapshot
  }
  settle(write: SourceWrite, saved: boolean) {
    const current = this.writes.get(bindingKey(write.repo))
    if (
      saved &&
      current &&
      write.owner &&
      current.owner === write.owner &&
      this.owners.get(bindingKey(write.repo)) === write.owner
    ) {
      current.acknowledged = write.preference
    }
    write.pending = false
    this.snapshot = undefined
    if (current === write) {
      this.store.setState((s) => {
        const preference = saved ? write.preference : write.acknowledged
        const repos = s.repos.map((repo) =>
          bindingKey(repo) === bindingKey(write.repo) && repo.issueSourcePreference !== preference
            ? { ...repo, issueSourcePreference: preference }
            : repo
        )
        return {
          repos: repos.every((repo, index) => repo === s.repos[index]) ? s.repos : repos,
          workItemsInvalidationNonce: s.workItemsInvalidationNonce + 1
        }
      })
      if (!saved) {
        write.failed = this.owners.get(bindingKey(write.repo))?.readbacks ?? 0
        void this.recover(write.repo, write)
      }
    }
    write.finish(saved && current === write)
  }
  /** 'save-failed': this press waited on a save whose own toast reports it; otherwise the final target check. */
  async awaitSave(repo: Repo): Promise<'save-failed' | (() => boolean)> {
    const key = bindingKey(repo)
    const target = this.store.getState().repos.find((row) => bindingKey(row) === key)
    if (!target || githubCandidateOwner(target) !== githubCandidateOwner(repo)) {
      return unsafeTarget
    }
    const owner = this.owners.get(key)
    const write = this.writes.get(key)
    if (write?.pending && !(await write.settled)) {
      return write.failed === undefined ? unsafeTarget : 'save-failed'
    }
    // Why: a failed write may still have reached the host; only its readback says which source create will use.
    if (write?.failed !== undefined) {
      await this.recover(target, write)
      if ((this.owners.get(key)?.readbacks ?? 0) <= write.failed) {
        return unsafeTarget
      }
    }
    const binding = this.store.getState().githubTaskCache.capture(target)
    return () => {
      const current = this.store.getState().repos.find((row) => bindingKey(row) === key)
      return (
        !!current &&
        this.owners.get(key) === owner &&
        this.writes.get(key) === write &&
        !write?.pending &&
        githubTaskBinding(current) === githubTaskBinding(target) &&
        (!binding || this.store.getState().githubTaskCache.current(binding))
      )
    }
  }

  /** One catalog readback per episode at a time; re-armed only when no row came back, so Refresh can retry. */
  recover(repo: Repo, episode: RecoveryEpisode) {
    let running = this.recoveries.get(episode)
    if (!running) {
      const owner = this.owners.get(bindingKey(repo))
      const before = owner?.readbacks
      running = Promise.resolve(this.store.getState().fetchReposForAllHosts?.())
        .catch(() => undefined)
        .then(() => {
          if (owner?.readbacks === before) {
            this.recoveries.delete(episode)
          }
        })
      this.recoveries.set(episode, running)
    }
    return running
  }
  /**
   * Re-reads a collection made obsolete by a searched repo's pending save once that save settles, while the caller
   * and every owner present at entry live. Store acceptance still decides what the read may publish.
   */
  async readCurrent<T>(
    repos: readonly (Repo | undefined)[],
    read: () => Promise<T | undefined>,
    signal?: AbortSignal
  ) {
    const entry = repos.map((repo) => {
      const owner = repo && this.owners.get(bindingKey(repo))
      return { repo, owner, context: owner?.id }
    })
    // Why: a removed/re-added or retired owner, or a changed binding, is another lifetime; a bound read never turns unbound.
    const live = () =>
      !signal?.aborted &&
      entry.every(
        ({ repo, owner, context }) =>
          !repo ||
          (this.owners.get(bindingKey(repo)) === owner &&
            (!owner ||
              (owner.id === context && githubTaskBinding(owner.repo) === githubTaskBinding(repo))))
      )
    const pending = () =>
      entry.flatMap(({ repo }) => {
        const write = repo && this.writes.get(bindingKey(repo))
        return write?.pending ? [write] : []
      })
    for (let reads = 0; reads < 3 && live(); reads++) {
      const held = pending().length
      const value = await read()
      // Why: replay only after a held save actually settled, never over unchanged obsolete state.
      if (value !== undefined || held === 0) {
        return value
      }
      // A superseded save ends while its successor is pending; following it spends no read.
      for (let waiting = pending(); waiting.length && live(); waiting = pending()) {
        await waitForWriteEnd(waiting, signal)
      }
    }
    return undefined
  }

  context(repo: Repo) {
    return this.owners.get(bindingKey(repo))?.id ?? 0
  }
  capture(repo: Repo | undefined, source?: TaskSourceContext | null): Attempt {
    const write = repo && this.writes.get(bindingKey(repo))
    const owner = repo ? this.owners.get(bindingKey(repo)) : undefined
    return {
      repo,
      owner,
      context: owner?.id,
      order: nextProviderRequestId(),
      source,
      binding: this.store.getState().githubTaskCache.capture(repo, source),
      write,
      eligible: !write?.pending,
      scope: githubCollectionScope(repo, source)
    }
  }
  owns(attempt: Attempt) {
    return (
      !attempt.repo ||
      (this.owners.get(bindingKey(attempt.repo)) === attempt.owner &&
        (!attempt.binding || isHostIdentityContinued(attempt.binding.observation.fence)))
    )
  }
  current(attempt: Attempt) {
    return (
      attempt.eligible &&
      (!attempt.binding || this.store.getState().githubTaskCache.current(attempt.binding)) &&
      (!attempt.repo ||
        (this.writes.get(bindingKey(attempt.repo)) === attempt.write &&
          this.owners.get(bindingKey(attempt.repo)) === attempt.owner &&
          attempt.owner?.id === attempt.context))
    )
  }
  sync(repos: readonly Repo[]) {
    const live = new Map(repos.map((repo) => [bindingKey(repo), repo]))
    const retired: CollectionOwner[] = []
    for (const [key, owner] of this.owners) {
      const next = live.get(key),
        write = this.writes.get(key)
      const ownedFlip =
        next &&
        write &&
        (write.pending
          ? next.issueSourcePreference === write.preference
          : next.issueSourcePreference === write.acknowledged)
      if (
        !next ||
        githubCandidateOwner(next) !== githubCandidateOwner(owner.repo) ||
        (!ownedFlip && githubTaskBinding(next) !== githubTaskBinding(owner.repo)) ||
        (owner.binding && !isHostIdentityContinued(owner.binding.observation.fence))
      ) {
        this.writes.delete(key)
        write?.finish(false)
        this.owners.delete(key)
        retired.push(owner)
      }
    }
    // Why one batch: removing many rows at once must not rebuild and publish the shared cache per owner.
    if (retired.length) {
      this.snapshot = undefined
      this.retireOwners(retired)
    }
    for (const repo of repos) {
      const key = bindingKey(repo)
      const previous = this.owners.get(key)
      const binding = this.store.getState().githubTaskCache.capture(repo)
      if (previous) {
        previous.repo = repo
        previous.binding = binding
      } else {
        this.owners.set(key, { repo, binding, id: nextProviderRequestId(), order: 0, readbacks: 0 })
        this.snapshot = undefined
      }
    }
  }
}
