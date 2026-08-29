import { useCallback, useEffect, useMemo } from 'react'

import { taskPageGitHubItemKey } from '@/components/task-page-github-work-item-mutation-registry'
import type { TaskPageRepoSourceState } from '@/components/task-page-cache-selectors'
import { deriveAdvertisedTotalPages } from '@/components/task-page-work-item-pagination'
import { deriveTaskPagePRCheckSummary } from '@/components/task-page-pr-check-summary'
import { sameOptionalGitHubOwnerRepo } from '@/components/task-page/github/github-reviewer-suggestions'
import {
  GITHUB_PR_TASK_GRID_CLASS,
  GITHUB_TASK_GRID_CLASS
} from '@/components/task-page/github/github-task-surface-classes'
import { PR_CHECKS_EAGER_PREFETCH_LIMIT } from '@/components/task-page/task-page-list-limits'
import { getTaskPageRepoSourceContext } from '@/components/task-page/source/repo-source-context'
import type { GitHubTaskKind } from '@/components/task-page-localized-options'
import type { AppState } from '@/store/types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskProvider } from '../../../../../shared/task-providers'

export function useTaskPageGitHubFilteredItems({
  activeGithubTaskKind,
  pages,
  currentPage,
  githubWorkItemMutation,
  tasksFiltering,
  tasksLoading,
  perRepoSourceState,
  repoMap,
  fetchPRChecks,
  patchTaskPageWorkItemRows,
  taskSource,
  githubMode,
  githubPageSize,
  countedTotalPages,
  provenPageLimit
}: {
  activeGithubTaskKind: GitHubTaskKind
  pages: (GitHubWorkItem[] | null)[]
  currentPage: number
  githubWorkItemMutation: { softHiddenItemKeys: ReadonlySet<string> }
  tasksFiltering: boolean
  tasksLoading: boolean
  perRepoSourceState: TaskPageRepoSourceState[]
  repoMap: Map<string, Repo>
  fetchPRChecks: AppState['fetchPRChecks']
  patchTaskPageWorkItemRows: (
    itemKey: { id: string; repoId: string },
    patch: Partial<GitHubWorkItem>,
    shouldPatch?: (item: GitHubWorkItem) => boolean
  ) => void
  taskSource: TaskProvider
  githubMode: 'items' | 'project'
  githubPageSize: number
  countedTotalPages: number | null
  provenPageLimit: number | null
}) {
  // Why: defense-in-depth — keep stale cache rows from leaking across the issue/PR split tabs.
  const applyTypeFilter = useCallback(
    (items: GitHubWorkItem[]) => {
      return items.filter((item) => {
        return activeGithubTaskKind === 'prs' ? item.type === 'pr' : item.type === 'issue'
      })
    },
    [activeGithubTaskKind]
  )

  const currentPageItems = useMemo(() => pages[currentPage] ?? [], [pages, currentPage])

  const typeFilteredCurrentPageItems = useMemo(
    () => applyTypeFilter(currentPageItems),
    [applyTypeFilter, currentPageItems]
  )
  // Why: soft-hide keeps membership-exit rows in pages for rollback/cursors but
  // removes them from the visible table (sticky ∪ pending membership).
  const filteredWorkItems = useMemo(
    () =>
      typeFilteredCurrentPageItems.filter(
        (workItem) =>
          !githubWorkItemMutation.softHiddenItemKeys.has(
            taskPageGitHubItemKey(workItem.repoId, workItem.id)
          )
      ),
    [githubWorkItemMutation.softHiddenItemKeys, typeFilteredCurrentPageItems]
  )
  const softHiddenVisibleCount = useMemo(
    () => typeFilteredCurrentPageItems.length - filteredWorkItems.length,
    [filteredWorkItems.length, typeFilteredCurrentPageItems.length]
  )
  const showGitHubTaskSkeletons = tasksFiltering || (tasksLoading && filteredWorkItems.length === 0)
  const loadedGitHubAuthorLogins = useMemo(() => {
    const seen = new Set<string>()
    const logins: string[] = []
    for (const page of pages) {
      if (!page) {
        continue
      }
      for (const item of page) {
        if (
          !item.author ||
          (activeGithubTaskKind === 'prs' ? item.type !== 'pr' : item.type !== 'issue')
        ) {
          continue
        }
        const key = item.author.toLowerCase()
        if (seen.has(key)) {
          continue
        }
        seen.add(key)
        logins.push(item.author)
      }
    }
    return logins
  }, [activeGithubTaskKind, pages])
  const primaryGithubFilterSlug = useMemo(() => {
    for (const state of perRepoSourceState) {
      const source = activeGithubTaskKind === 'prs' ? state.sources?.prs : state.sources?.issues
      if (source) {
        return source
      }
    }
    return null
  }, [activeGithubTaskKind, perRepoSourceState])
  const showPRManagementColumns = activeGithubTaskKind === 'prs'
  const githubTaskGridClass = showPRManagementColumns
    ? GITHUB_PR_TASK_GRID_CLASS
    : GITHUB_TASK_GRID_CLASS

  const ensurePRChecksLoaded = useCallback(
    (item: GitHubWorkItem): void => {
      if (item.type !== 'pr' || item.checksSummary) {
        return
      }
      const repo = repoMap.get(item.repoId)
      if (!repo) {
        return
      }
      const requestedHeadSha = item.headSha
      const requestedPRRepo = item.prRepo ?? null
      void fetchPRChecks(
        repo.path,
        item.number,
        item.branchName,
        item.headSha,
        item.prRepo ?? null,
        { repoId: repo.id, sourceContext: getTaskPageRepoSourceContext(repo, 'github') }
      )
        .then((checks) => {
          patchTaskPageWorkItemRows(
            { id: item.id, repoId: item.repoId },
            { checksSummary: deriveTaskPagePRCheckSummary(checks) },
            (currentItem) =>
              currentItem.type === 'pr' &&
              currentItem.headSha === requestedHeadSha &&
              sameOptionalGitHubOwnerRepo(currentItem.prRepo, requestedPRRepo)
          )
        })
        .catch((err) => {
          console.error('Failed to prefetch PR checks:', err)
        })
    },
    [fetchPRChecks, patchTaskPageWorkItemRows, repoMap]
  )

  useEffect(() => {
    if (taskSource !== 'github' || githubMode !== 'items' || !showPRManagementColumns) {
      return
    }

    for (const item of filteredWorkItems.slice(0, PR_CHECKS_EAGER_PREFETCH_LIMIT)) {
      ensurePRChecksLoaded(item)
    }
  }, [ensurePRChecksLoaded, filteredWorkItems, githubMode, showPRManagementColumns, taskSource])

  let lastLoadedPageIndex = 0
  for (let index = 0; index < pages.length; index += 1) {
    if (pages[index] !== null) {
      lastLoadedPageIndex = index
    }
  }
  // Why: when counts fail, a full loaded page is enough evidence to expose one more page without faking empty results.
  const lastLoadedPageFull =
    (pages[lastLoadedPageIndex]?.length ?? 0) >= Math.max(1, githubPageSize)
  const fallbackTotalPages = lastLoadedPageFull
    ? Math.max(pages.length, lastLoadedPageIndex + 2)
    : Math.max(1, pages.length)
  const totalPages = deriveAdvertisedTotalPages({
    loadedPages: pages.length,
    countedTotalPages,
    fallbackTotalPages,
    provenPageLimit
  })

  return {
    filteredWorkItems,
    softHiddenVisibleCount,
    showGitHubTaskSkeletons,
    loadedGitHubAuthorLogins,
    primaryGithubFilterSlug,
    showPRManagementColumns,
    githubTaskGridClass,
    ensurePRChecksLoaded,
    totalPages
  }
}
