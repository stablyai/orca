import type { Repo } from '../../../../../../shared/repo-types'
import type { HostAuthorityKey } from '../../../../../../shared/host-authority'
import type { GitHubIssueOrPRLink } from '../../../../../../shared/github/repositories/links'
import {
  githubHostFromIdentityKey,
  githubRepoIdentityKey
} from '../../../../../../shared/github/repositories/repository-identity-key'
import {
  getRepoSlugCacheVersion,
  nextRepoSlugFailureRetryDelay,
  readRepoSlugCache,
  repoSlugCacheKey,
  subscribeRepoSlugCache
} from '@/lib/workspace/catalog/repo-slug-cache'
import {
  findGitHubPreviewRouteRepo,
  githubPreviewRepoIdentity,
  githubPreviewRouteCandidates,
  githubPreviewRouteRank
} from './native-chat-github-route-repo'

type Candidate = { repo: Repo; order: number; rank: number; cacheKey: string | null }

export type GitHubPreviewRouteStore = ReturnType<typeof createGitHubPreviewRouteStore>

export function createGitHubPreviewRouteStore(
  repos: readonly Repo[],
  authority: HostAuthorityKey,
  link: GitHubIssueOrPRLink
) {
  const linkKey = githubRepoIdentityKey(link.slug)
  const linkHost = githubHostFromIdentityKey(linkKey)
  const candidates = githubPreviewRouteCandidates(repos, authority).map((repo, order) => ({
    repo,
    order,
    rank: 3,
    cacheKey: repoSlugCacheKey(repo)
  }))
  const identities = new Set(candidates.map(({ repo }) => githubPreviewRepoIdentity(repo)))
  const byCacheKey = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    if (candidate.cacheKey) {
      const entries = byCacheKey.get(candidate.cacheKey) ?? []
      entries.push(candidate)
      byCacheKey.set(candidate.cacheKey, entries)
    }
  }
  const listeners = new Set<() => void>()
  let stop: (() => void) | null = null
  let retainers = 0
  let version = -1
  let selected: Candidate | null = null
  let resolving: Promise<Repo | null> | null = null
  let resolved = false
  let retryAt = Number.POSITIVE_INFINITY
  let notificationPending = false

  const outranks = (candidate: Candidate, current: Candidate | null): boolean =>
    candidate.rank < 3 &&
    (!current ||
      candidate.rank < current.rank ||
      (candidate.rank === current.rank && candidate.order < current.order))
  const updateRank = (candidate: Candidate): void => {
    const cached = candidate.cacheKey ? readRepoSlugCache(candidate.cacheKey) : null
    if (!cached?.hit) {
      resolved = false
    }
    if (candidate.cacheKey && cached?.hit && cached.value === null) {
      const now = Date.now()
      const delay = nextRepoSlugFailureRetryDelay(new Set([candidate.cacheKey]), now)
      if (delay !== null) {
        retryAt = Math.min(retryAt, now + delay)
      }
    }
    candidate.rank = githubPreviewRouteRank(
      candidate.repo,
      cached?.hit ? cached.value : null,
      linkKey,
      linkHost
    )
  }
  const select = (): void => {
    selected = null
    for (const candidate of candidates) {
      if (outranks(candidate, selected)) {
        selected = candidate
      }
    }
  }
  const refresh = (): void => {
    for (const candidate of candidates) {
      updateRank(candidate)
    }
    select()
    version = getRepoSlugCacheVersion()
  }
  const read = (): Repo | null => {
    if (version !== getRepoSlugCacheVersion()) {
      refresh()
    }
    return selected?.repo ?? null
  }
  const changed = (cacheKey: string | null): void => {
    const previous = selected?.repo ?? null
    if (cacheKey === null) {
      refresh()
    } else {
      let reselect = false
      for (const candidate of byCacheKey.get(cacheKey) ?? []) {
        const rank = candidate.rank
        updateRank(candidate)
        if (candidate === selected && candidate.rank > rank) {
          reselect = true
        }
        if (outranks(candidate, selected)) {
          selected = candidate
        }
      }
      // Losing the selected binding needs a replacement; cold resolutions only promote one row.
      if (reselect) {
        select()
      }
      version = getRepoSlugCacheVersion()
    }
    if (previous !== (selected?.repo ?? null) && !notificationPending) {
      notificationPending = true
      // Update every card's index before React reads their snapshots together.
      queueMicrotask(() => {
        notificationPending = false
        for (const listener of listeners) {
          listener()
        }
      })
    }
  }
  const retain = (): (() => void) => {
    read()
    retainers += 1
    stop ??= subscribeRepoSlugCache(changed)
    return () => {
      retainers -= 1
      if (retainers === 0) {
        stop?.()
        stop = null
      }
    }
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    const release = retain()
    return () => {
      listeners.delete(listener)
      release()
    }
  }
  const find = async (): Promise<Repo | null> => {
    const repo = read()
    if (resolved && Date.now() < retryAt) {
      return repo
    }
    resolving ??= findGitHubPreviewRouteRepo(repos, authority, link)
      .then((result) => {
        resolved = true
        const now = Date.now()
        const delay = nextRepoSlugFailureRetryDelay(new Set(byCacheKey.keys()), now)
        retryAt = delay === null ? Number.POSITIVE_INFINITY : now + delay
        return result
      })
      .finally(() => {
        resolving = null
      })
    await resolving
    return read()
  }
  return { repos, identities, read, subscribe, retain, find }
}
