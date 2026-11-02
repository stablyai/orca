import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { CacheEntry } from './cache-model'
import { getTaskSourceCacheScope } from '../../../../shared/task-source-context'
import { githubTaskBinding } from '@/lib/github-task-observation'
import { bindingKey, type TaskBinding } from './task-record-model'
import { isHostIdentityContinued } from '../host-catalog-fencing'
import { nextProviderRequestId } from './request-coordination'

export const githubCandidateOwner = (repo: Repo) =>
  githubTaskBinding({ ...repo, issueSourcePreference: undefined })
export const githubCollectionScope = (repo: Repo | undefined, source?: TaskSourceContext | null) =>
  JSON.stringify([repo && githubTaskBinding(repo), source && getTaskSourceCacheScope(source)])
type SourceWrite = {
  repo: Repo
  preference: Repo['issueSourcePreference']
  acknowledged: Repo['issueSourcePreference']
  pending: boolean
  settled: Promise<boolean>
  finish: (saved: boolean) => void
  owner: CollectionOwner | undefined
}
export type CollectionOwner = {
  repo: Repo
  binding: TaskBinding | undefined
  id: number
  order: number
  candidates?: CacheEntry<readonly GitHubWorkItem[]>
}
export type Attempt = {
  owner: CollectionOwner | undefined
  order: number
  nonce: number
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
  constructor(protected store: StoreApi<AppState>) {}
  protected abstract reuse(repo: Repo, preference: Repo['issueSourcePreference']): void
  protected abstract retireOwner(owner: CollectionOwner): void
  begin(repo: Repo, preference: Repo['issueSourcePreference']) {
    const previous = this.writes.get(bindingKey(repo))
    previous?.finish(false)
    const deferred = Promise.withResolvers<boolean>()
    const write: SourceWrite = {
      repo,
      owner: this.owners.get(bindingKey(repo)),
      preference,
      acknowledged: previous ? previous.acknowledged : repo.issueSourcePreference,
      pending: true,
      settled: deferred.promise,
      finish: deferred.resolve
    }
    this.writes.set(bindingKey(repo), write)
    this.reuse(repo, preference)
    return write
  }
  adopt(repo: Repo, started?: ReturnType<GitHubSourceOwnership['catalogSnapshot']>) {
    const key = bindingKey(repo)
    const owner = this.owners.get(key)
    const before = started?.get(key)
    if (
      started &&
      owner &&
      before?.owner !== owner &&
      githubCandidateOwner(repo) === githubCandidateOwner(owner.repo)
    ) {
      return { ...repo, issueSourcePreference: owner.repo.issueSourcePreference }
    }
    const write = this.writes.get(key)
    if (!write || githubCandidateOwner(repo) !== githubCandidateOwner(write.repo)) {
      return repo
    }
    const stale = started && (before?.write !== write || before.pending !== write.pending)
    return write.pending || stale
      ? { ...repo, issueSourcePreference: write.pending ? write.preference : write.acknowledged }
      : repo
  }
  catalogSnapshot() {
    return new Map(
      [...this.owners].map(([key, owner]) => {
        const write = this.writes.get(key)
        return [key, { owner, write, pending: write?.pending ?? false }]
      })
    )
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
    }
    write.finish(saved && current === write)
  }
  async awaitSave(repo: Repo) {
    const key = bindingKey(repo)
    const target = this.store.getState().repos.find((row) => bindingKey(row) === key)
    if (!target || githubCandidateOwner(target) !== githubCandidateOwner(repo)) {
      return undefined
    }
    const owner = this.owners.get(key)
    const write = this.writes.get(key)
    if (write?.pending && !(await write.settled)) {
      return undefined
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

  context(repo: Repo) {
    return this.owners.get(bindingKey(repo))?.id ?? 0
  }
  capture(repo: Repo | undefined, source?: TaskSourceContext | null): Attempt {
    const write = repo && this.writes.get(bindingKey(repo))
    return {
      repo,
      owner: repo ? this.owners.get(bindingKey(repo)) : undefined,
      order: nextProviderRequestId(),
      nonce: this.store.getState().workItemsInvalidationNonce,
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
          this.owners.get(bindingKey(attempt.repo)) === attempt.owner))
    )
  }
  sync(repos: readonly Repo[]) {
    const live = new Map(repos.map((repo) => [bindingKey(repo), repo]))
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
        this.retireOwner(owner)
      }
    }
    for (const repo of repos) {
      const key = bindingKey(repo)
      const previous = this.owners.get(key)
      const binding = this.store.getState().githubTaskCache.capture(repo)
      if (previous) {
        previous.repo = repo
        previous.binding = binding
      } else {
        this.owners.set(key, { repo, binding, id: nextProviderRequestId(), order: 0 })
      }
    }
  }
}
