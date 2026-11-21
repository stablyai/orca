import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import { resolveRepoSlug } from '@/lib/workspace/catalog/repo-slug-index'
import {
  getRepoSlugCacheVersion,
  nextRepoSlugFailureRetryDelay,
  repoSlugCacheKey,
  subscribeRepoSlugCache
} from '@/lib/workspace/catalog/repo-slug-cache'
import {
  githubReferenceRepo,
  type GitHubRepoReference
} from '../../../../../../shared/github/markdown/github-reference-links'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { readCachedOriginKey } from './native-chat-github-repo'

const NO_REPOS: readonly GitHubRepoReference[] = []

/** Each cached project slug once, sorted, as `owner/repo` lines: project order and extra
 *  checkouts of a repo don't change it. */
function cachedReferenceKey(repos: readonly Repo[]): string {
  const slugs = repos.flatMap((repo) => {
    const originKey = readCachedOriginKey(repo)
    const reference = originKey ? githubReferenceRepo(repo, originKey) : null
    return reference ? [`${reference.owner}/${reference.repo}`] : []
  })
  return [...new Set(slugs)].sort().join('\n')
}

/** The GitHub repo of every git project in Orca, so a chat's `name#123` can name one of them. */
export function useProjectGitHubRepos(): readonly GitHubRepoReference[] {
  const repos = useAppStore((state) => state.repos)
  const slugCacheVersion = useSyncExternalStore(subscribeRepoSlugCache, getRepoSlugCacheVersion)
  const gitRepos = useMemo(() => repos.filter((repo) => !repo.kind || repo.kind === 'git'), [repos])
  const [retryGeneration, setRetryGeneration] = useState(0)
  const [retryDelayMs, setRetryDelayMs] = useState<number | null>(null)

  // Fill the slug cache; its change notifications re-derive the list below.
  useEffect(() => {
    let cancelled = false
    setRetryDelayMs(null)
    void Promise.all(gitRepos.map(resolveRepoSlug)).then(() => {
      if (!cancelled) {
        const cacheKeys = new Set(gitRepos.flatMap((repo) => repoSlugCacheKey(repo) ?? []))
        setRetryDelayMs(nextRepoSlugFailureRetryDelay(cacheKeys))
      }
    })
    return () => {
      cancelled = true
    }
  }, [gitRepos, slugCacheVersion, retryGeneration])

  // A failed lookup expires without a cache notification; ask again once it does.
  useEffect(() => {
    if (retryDelayMs === null) {
      return
    }
    const retryTimer = setTimeout(() => setRetryGeneration((value) => value + 1), retryDelayMs)
    return () => clearTimeout(retryTimer)
  }, [retryDelayMs])

  // Derived from the current projects only, so a closed project never lingers.
  const referenceKey = useSyncExternalStore(subscribeRepoSlugCache, () =>
    cachedReferenceKey(gitRepos)
  )
  // Every chat message's markdown depends on this list; keep its identity while it is the same.
  return useMemo(
    () =>
      referenceKey
        ? referenceKey.split('\n').map((slug) => {
            const [owner = '', repo = ''] = slug.split('/')
            return { owner, repo }
          })
        : NO_REPOS,
    [referenceKey]
  )
}
