import type { StoreApi } from 'zustand'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { ListWorkItemsResult } from '../../../../shared/github/work-item-types'
import type { WorkItemsCacheSources } from './cache-model'
import { githubTaskBinding } from '@/lib/github-task-observation'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { bindingKey } from './task-record-model'
import { nextProviderRequestId } from './request-coordination'
import { withBoundedCacheEntry, evictStaleEntries } from './cache-policy'
import { workItemsCacheKey } from './cache-identity'
import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'
import {
  GitHubSourceOwnership,
  githubCollectionScope,
  type Attempt,
  type CollectionOwner
} from './source-preference-ownership'
export { githubCandidateOwner, githubCollectionScope } from './source-preference-ownership'

type Evidence = {
  attempt: Attempt
  sources: WorkItemsCacheSources
  empty: boolean
  fetchedAt: number
}
type CountAnswer = { totalCount: number; totalPages: number }

/** Collection membership and discovery reuse task bindings; accepted records own only task facts. */
export class GitHubSourceCollections extends GitHubSourceOwnership {
  private evidence: Record<string, Evidence> = {}
  private counts = new Map<
    string,
    {
      answer: CountAnswer
      scopes: string[]
      query: string
      limit: number
      fetchedAt: number
      owners: CollectionOwner[]
    }
  >()
  private resyncs = new WeakSet<object>()
  private listeners = new Set<() => void>()
  private revision = 0
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.revision
  private notify() {
    this.revision++
    for (const listener of this.listeners) {
      listener()
    }
  }
  protected reuse(repo: Repo, preference: Repo['issueSourcePreference']) {
    const oldBinding = githubTaskBinding(repo),
      nextBinding = githubTaskBinding({ ...repo, issueSourcePreference: preference })
    if (oldBinding === nextBinding) {
      return
    }
    const matches = (sources: WorkItemsCacheSources) => {
      const target =
        preference === 'origin'
          ? sources.originCandidate
          : (sources.upstreamCandidate ?? sources.originCandidate)
      return (
        target &&
        sources.issues &&
        sources.prs &&
        githubRepoIdentityKey(target) === githubRepoIdentityKey(sources.issues) &&
        githubRepoIdentityKey(target) === githubRepoIdentityKey(sources.prs)
      )
    }
    this.store.setState((state) => {
      let cache = state.workItemsCache
      for (const entry of Object.values(state.workItemsCache)) {
        const context = entry.collection
        if (
          !context ||
          context.owner !== this.context(repo) ||
          entry.error ||
          entry.issueSourceFellBack ||
          !entry.sources ||
          !matches(entry.sources)
        ) {
          continue
        }
        const key = workItemsCacheKey(
          repo.id,
          context.limit,
          context.query,
          context.cacheScope,
          nextBinding
        )
        cache = withBoundedCacheEntry(cache, key, { ...entry, sourceBinding: nextBinding })
      }
      return cache === state.workItemsCache ? state : { workItemsCache: cache }
    })
    for (const evidence of Object.values(this.evidence)) {
      if (
        !evidence.attempt.repo ||
        evidence.attempt.owner !== this.owners.get(bindingKey(repo)) ||
        !matches(evidence.sources)
      ) {
        continue
      }
      const oldScope = evidence.attempt.scope
      const nextScope = githubCollectionScope(
        { ...repo, issueSourcePreference: preference },
        evidence.attempt.source
      )
      for (const value of this.counts.values()) {
        if (!value.scopes.includes(oldScope)) {
          continue
        }
        const scopes = value.scopes.map((scope) => (scope === oldScope ? nextScope : scope))
        this.counts.set(this.countKey(scopes, value.query, value.limit), { ...value, scopes })
      }
    }
    this.boundCounts()
  }

  private evidenceKey(attempt: Attempt, query: string) {
    return JSON.stringify([attempt.scope, query.trim()])
  }
  private retire(scope: string, query?: string) {
    for (const [key, value] of this.counts) {
      if (value.scopes.includes(scope) && (query === undefined || value.query === query)) {
        this.counts.delete(key)
      }
    }
    this.notify()
  }
  accept(attempt: Attempt, envelope: ListWorkItemsResult, query: string, firstPage: boolean) {
    if (!this.current(attempt)) {
      return false
    }
    const { repo } = attempt
    const sources = envelope.sources
    const same = (a: WorkItemsCacheSources['issues'], b: WorkItemsCacheSources['issues']) =>
      a === b || (!!a && !!b && githubRepoIdentityKey(a) === githubRepoIdentityKey(b))
    const preference = repo?.issueSourcePreference
    const issues =
      preference === 'origin'
        ? sources.originCandidate
        : (sources.upstreamCandidate ??
          (envelope.issueSourceFellBack ? sources.originCandidate : null))
    const prs =
      preference === 'origin'
        ? sources.originCandidate
        : (sources.upstreamCandidate ?? sources.originCandidate)
    const valid =
      !attempt.binding ||
      !preference ||
      preference === 'auto' ||
      (same(issues, sources.issues) && same(prs, sources.prs))
    if (repo && attempt.binding && attempt.owner) {
      const owner = attempt.owner
      const previous = owner.candidates
      const candidateSources = {
        issues: null,
        prs: null,
        originCandidate: sources.originCandidate,
        upstreamCandidate: sources.upstreamCandidate
      }
      const mappingChanged = previous && !structuralValuesEqual(previous.sources, candidateSources)
      const effectiveChanged = Object.values(this.evidence).some(
        (value) =>
          value.attempt.scope === attempt.scope &&
          (!same(value.sources.issues, sources.issues) || !same(value.sources.prs, sources.prs))
      )
      if (attempt.order < owner.order && (mappingChanged || effectiveChanged || !valid)) {
        return false
      }
      owner.order = Math.max(owner.order, attempt.order)
      if (mappingChanged || effectiveChanged || !valid) {
        this.retireOwner(owner)
      }
      if (!previous || mappingChanged) {
        owner.candidates = { data: null, sources: candidateSources, fetchedAt: Date.now() }
        this.notify()
      }
    }
    if (!valid) {
      delete this.evidence[this.evidenceKey(attempt, query)]
      this.retire(attempt.scope)
      const episode = attempt.write ?? attempt.binding?.incarnation
      if (episode && !this.resyncs.has(episode)) {
        this.resyncs.add(episode)
        void this.store
          .getState()
          .fetchReposForAllHosts?.()
          .catch(() => undefined)
      }
      return false
    }
    if (firstPage) {
      const complete = !envelope.errors?.issues && !envelope.errors?.prs
      const empty = complete && envelope.items.length === 0
      this.evidence = withBoundedCacheEntry(this.evidence, this.evidenceKey(attempt, query), {
        attempt,
        sources,
        empty,
        fetchedAt: Date.now()
      })
      if (empty) {
        this.retire(attempt.scope, query.trim())
      }
    }
    return true
  }
  verified(attempt: Attempt, query: string) {
    const evidence = this.evidence[this.evidenceKey(attempt, query)]
    return evidence &&
      evidence.attempt.binding?.incarnation === attempt.binding?.incarnation &&
      evidence.attempt.write === attempt.write
      ? evidence
      : undefined
  }
  candidate(repo: Repo) {
    return this.owners.get(bindingKey(repo))?.candidates
  }
  countKey(scopes: readonly string[], query: string, limit: number) {
    return JSON.stringify([[...scopes].sort(), query.trim(), limit])
  }
  count(key: string) {
    const value = this.counts.get(key)
    if (value) {
      value.fetchedAt = Date.now()
    }
    return value?.answer
  }
  answer(key: string, attempts: Attempt[], answer: CountAnswer, query: string, limit: number) {
    this.counts.set(key, {
      answer,
      scopes: attempts.map((a) => a.scope),
      query: query.trim(),
      limit,
      fetchedAt: Date.now(),
      owners: attempts.flatMap((a) => (a.owner ? [a.owner] : []))
    })
    this.boundCounts()
    this.notify()
    return answer
  }
  private boundCounts() {
    this.counts = new Map(Object.entries(evictStaleEntries(Object.fromEntries(this.counts))))
  }
  protected retireOwner(owner: CollectionOwner) {
    for (const [key, evidence] of Object.entries(this.evidence)) {
      if (evidence.attempt.owner === owner) {
        delete this.evidence[key]
      }
    }
    for (const [key, count] of this.counts) {
      if (count.owners.includes(owner)) {
        this.counts.delete(key)
      }
    }
    taskPageGitHubResumeCache.retireOwner(owner.id)
    const oldId = owner.id
    owner.id = nextProviderRequestId()
    this.store.setState((state) => ({
      workItemsCache: Object.fromEntries(
        Object.entries(state.workItemsCache).filter(
          ([, entry]) => entry.collection?.owner !== oldId
        )
      ),
      workItemsInvalidationNonce: state.workItemsInvalidationNonce + 1
    }))
    this.notify()
  }
}
export function createGitHubSourceCollections(store: StoreApi<AppState>) {
  const cache = new GitHubSourceCollections(store)
  store.subscribe((state, previous) => {
    if (
      state.repos !== previous.repos ||
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
      state.runtimeEnvironments !== previous.runtimeEnvironments ||
      state.sshConnectionStates !== previous.sshConnectionStates ||
      state.sshStateByEnvironment !== previous.sshStateByEnvironment
    ) {
      cache.sync(state.repos ?? [])
    }
  })
  return cache
}
