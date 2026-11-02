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
type CountRecord = {
  answer: CountAnswer
  scopes: string[]
  query: string
  limit: number
  fetchedAt: number
  owners: CollectionOwner[]
}

/** Collection membership and discovery reuse task bindings; accepted records own only task facts. */
export class GitHubSourceCollections extends GitHubSourceOwnership {
  private evidence: Record<string, Evidence> = {}
  private counts = new Map<string, CountRecord>()
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private notify() {
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
      const additions: typeof state.workItemsCache = {}
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
        additions[key] = { ...entry, sourceBinding: nextBinding }
      }
      return Object.keys(additions).length
        ? { workItemsCache: evictStaleEntries({ ...state.workItemsCache, ...additions }) }
        : state
    })
    const scopes = new Map<string, string>()
    for (const evidence of Object.values(this.evidence)) {
      if (
        evidence.attempt.repo &&
        evidence.attempt.owner === this.owners.get(bindingKey(repo)) &&
        !scopes.has(evidence.attempt.scope) &&
        matches(evidence.sources)
      ) {
        scopes.set(
          evidence.attempt.scope,
          githubCollectionScope(
            { ...repo, issueSourcePreference: preference },
            evidence.attempt.source
          )
        )
      }
    }
    if (scopes.size === 0) {
      return
    }
    // Collected first so the one pass never visits the aliases it adds.
    const aliases = new Map<string, CountRecord>()
    for (const value of this.counts.values()) {
      if (value.scopes.some((scope) => scopes.has(scope))) {
        const next = value.scopes.map((scope) => scopes.get(scope) ?? scope)
        aliases.set(this.countKey(next, value.query, value.limit), { ...value, scopes: next })
      }
    }
    for (const [key, value] of aliases) {
      this.counts.set(key, value)
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
  accept(
    attempt: Attempt,
    envelope: ListWorkItemsResult<unknown>,
    query: string,
    firstPage: boolean
  ) {
    if (!this.current(attempt)) {
      return false
    }
    const { repo } = attempt
    const sources = envelope.sources
    const same = (a?: WorkItemsCacheSources['issues'], b?: WorkItemsCacheSources['issues']) =>
      a === b || (!!a && !!b && githubRepoIdentityKey(a) === githubRepoIdentityKey(b))
    // Why: older hosts omit the raw candidates. Absent is unavailable evidence, never a contradiction (present null is
    // unresolved): the collection is admitted under the effective issue/PR sources it reports, and candidate knowledge
    // is neither checked nor replaced by it.
    const unavailable =
      sources.originCandidate === undefined || sources.upstreamCandidate === undefined
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
      unavailable ||
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
      const mappingChanged =
        !unavailable && previous && !structuralValuesEqual(previous.sources, candidateSources)
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
        this.retireOwners([owner])
      }
      if (!unavailable && (!previous || mappingChanged)) {
        owner.candidates = { data: null, sources: candidateSources, fetchedAt: Date.now() }
        this.notify()
      }
    }
    if (!valid) {
      delete this.evidence[this.evidenceKey(attempt, query)]
      this.retire(attempt.scope)
      const episode = attempt.write ?? attempt.binding?.incarnation
      if (repo && episode) {
        void this.recover(repo, episode)
      }
      return false
    }
    if (firstPage && attempt.binding && attempt.owner) {
      if (envelope.errors?.issues || envelope.errors?.prs) {
        delete this.evidence[this.evidenceKey(attempt, query)]
        return true
      }
      const empty = envelope.items.length === 0
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
  /** Each owner's lifetime ends on its own; the shared cache is rebuilt and published once per batch. */
  protected retireOwners(owners: readonly CollectionOwner[]) {
    const retired = new Set(owners)
    for (const [key, evidence] of Object.entries(this.evidence)) {
      if (evidence.attempt.owner && retired.has(evidence.attempt.owner)) {
        delete this.evidence[key]
      }
    }
    for (const [key, count] of this.counts) {
      if (count.owners.some((owner) => retired.has(owner))) {
        this.counts.delete(key)
      }
    }
    const oldIds = new Set<number>()
    for (const owner of owners) {
      taskPageGitHubResumeCache.retireOwner(owner.id)
      oldIds.add(owner.id)
      owner.id = nextProviderRequestId()
    }
    this.store.setState((state) => {
      const kept = Object.entries(state.workItemsCache).filter(
        ([, entry]) => !entry.collection || !oldIds.has(entry.collection.owner)
      )
      return {
        workItemsCache:
          kept.length === Object.keys(state.workItemsCache).length
            ? state.workItemsCache
            : Object.fromEntries(kept),
        workItemsInvalidationNonce: state.workItemsInvalidationNonce + 1
      }
    })
    this.notify()
  }
}
