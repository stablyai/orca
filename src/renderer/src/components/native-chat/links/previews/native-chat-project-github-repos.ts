import { useEffect, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import { resolveRepoSlug } from '@/lib/workspace/catalog/repo-slug-index'
import {
  getRepoSlugCacheVersion,
  subscribeRepoSlugCache
} from '@/lib/workspace/catalog/repo-slug-cache'
import {
  githubReferenceRepo,
  type GitHubRepoReference
} from '../../../../../../shared/github/markdown/github-reference-links'

const NO_REPOS: readonly GitHubRepoReference[] = []

function referenceKey(repos: readonly GitHubRepoReference[]): string {
  return repos.map(({ owner, repo }) => `${owner}/${repo}`.toLowerCase()).join('\n')
}

/** The GitHub repo of every git project in Orca, so a chat's `name#123` can name one of them. */
export function useProjectGitHubRepos(): readonly GitHubRepoReference[] {
  const repos = useAppStore((state) => state.repos)
  const slugCacheVersion = useSyncExternalStore(subscribeRepoSlugCache, getRepoSlugCacheVersion)
  const [references, setReferences] = useState(NO_REPOS)

  useEffect(() => {
    let cancelled = false
    const gitRepos = repos.filter((repo) => !repo.kind || repo.kind === 'git')
    void Promise.all(
      gitRepos.map(async (repo) => {
        const originKey = await resolveRepoSlug(repo)
        return originKey ? githubReferenceRepo(repo, originKey) : null
      })
    ).then((resolved) => {
      if (cancelled) {
        return
      }
      const next = resolved.filter((reference) => reference !== null)
      // Every chat message's markdown depends on this list; keep its identity while it is the same.
      setReferences((current) => (referenceKey(current) === referenceKey(next) ? current : next))
    })
    return () => {
      cancelled = true
    }
  }, [repos, slugCacheVersion])

  return references
}
