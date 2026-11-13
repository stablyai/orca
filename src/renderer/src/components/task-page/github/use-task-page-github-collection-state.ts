import { useState, useCallback, useMemo, useSyncExternalStore, type SetStateAction } from 'react'
import type { TaskPageProviderStateModel } from '../use-task-page-provider-state'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import { sortWorkItemsByNumber } from '../../../../../shared/work-items/work-item-order'
import { stripRepoQualifiers } from '../../../../../shared/work-items/task-query'
import type { GitHubSourceCollections } from '@/store/github/sources/source-collections'
import { githubCollectionScope } from '@/store/github/sources/source-preference-ownership'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'
import { buildTaskPageGitHubResumeContextKey } from './task-page-github-resume-cache'

type CollectionInput = Pick<
  TaskPageProviderStateModel,
  'selectedRepos' | 'getCachedWorkItems' | 'initialTaskQuery'
> & {
  collections: GitHubSourceCollections
  selectedReposKey: string
  appliedTaskSearch: string
  githubPageSize: number
  githubPerRepoPageLimit: number
}

/** Mounted pages and speculative bounds belong to the selected collection; provider estimates stay in the store. */
export function useTaskPageGitHubCollectionState(input: CollectionInput) {
  const {
    collections,
    selectedRepos,
    selectedReposKey,
    initialTaskQuery,
    getCachedWorkItems,
    appliedTaskSearch,
    githubPageSize,
    githubPerRepoPageLimit
  } = input
  const githubResumeContextKey = buildTaskPageGitHubResumeContextKey({
    selectedReposKey,
    query: appliedTaskSearch.trim(),
    pageSize: githubPageSize
  })
  // Null slots permit direct numbered-page loading without reading intermediate pages.
  const [pageState, setPageState] = useState(() => {
    const empty: (GitHubWorkItem[] | null)[] = [[]]
    const trimmed = initialTaskQuery.trim()
    const merged: GitHubWorkItem[] = []
    for (const r of selectedRepos) {
      const cached = getCachedWorkItems(
        r.id,
        githubPerRepoPageLimit,
        trimmed,
        r.path,
        getTaskPageRepoSourceContext(r, 'github')
      )
      if (cached) {
        merged.push(...cached)
      }
    }
    if (merged.length === 0) {
      return { key: githubResumeContextKey, value: empty }
    }
    const page0 = sortWorkItemsByNumber(merged).slice(0, githubPageSize)
    return { key: githubResumeContextKey, value: [page0] }
  })
  const pages = useMemo(
    () => (pageState.key === githubResumeContextKey ? pageState.value : []),
    [githubResumeContextKey, pageState]
  )
  const setPages = useCallback(
    (update: SetStateAction<(GitHubWorkItem[] | null)[]>) =>
      setPageState((previous) => ({
        key: githubResumeContextKey,
        value:
          typeof update === 'function'
            ? update(previous.key === githubResumeContextKey ? previous.value : [])
            : update
      })),
    [githubResumeContextKey]
  )
  const countKey = collections.countKey(
    selectedRepos.map((repo) =>
      githubCollectionScope(repo, getTaskPageRepoSourceContext(repo, 'github'))
    ),
    stripRepoQualifiers(appliedTaskSearch.trim()),
    githubPerRepoPageLimit
  )
  const speculativeKey = JSON.stringify([countKey, selectedReposKey])
  const knownCount = useSyncExternalStore(
    collections.subscribe,
    () => collections.count(countKey)?.totalPages ?? null
  )
  const [countState, setCountState] = useState<{ key: string; value: number | null }>({
    key: speculativeKey,
    value: null
  })
  const countedTotalPages =
    knownCount && knownCount > 0
      ? knownCount
      : ((countState.key === speculativeKey ? countState.value : null) ?? knownCount)
  const setCountedTotalPages = useCallback(
    (update: SetStateAction<number | null>) =>
      setCountState((previous) => ({
        key: speculativeKey,
        value:
          typeof update === 'function'
            ? update(knownCount ?? (previous.key === speculativeKey ? previous.value : null))
            : update
      })),
    [speculativeKey, knownCount]
  )
  return { githubResumeContextKey, pages, setPages, countedTotalPages, setCountedTotalPages }
}
