import type { TaskPageJiraCreationMetadataModel } from './use-task-page-jira-creation-metadata'
import { useCallback, useMemo, useEffect } from 'react'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { taskPageGitHubItemKey } from '@/components/task-page-github-work-item-mutation-registry'
import { deriveTaskPagePRCheckSummary } from '@/components/task-page-pr-check-summary'
import { deriveAdvertisedTotalPages } from '@/components/task-page-work-item-pagination'
import {
  GITHUB_PR_TASK_GRID_CLASS,
  GITHUB_TASK_GRID_CLASS,
  PR_CHECKS_EAGER_PREFETCH_LIMIT,
  getTaskPageRepoSourceContext
} from './task-page-source-context'
import { sameOptionalGitHubOwnerRepo } from './task-page-github-review-model'
export function useTaskPageGitHubListProjection(model: TaskPageJiraCreationMetadataModel) {
  const {
    repoMap,
    fetchPRChecks,
    taskSource,
    githubMode,
    tasksLoading,
    tasksFiltering,
    githubPageSize,
    pages,
    currentPage,
    countedTotalPages,
    provenPageLimit,
    patchTaskPageWorkItemRows,
    perRepoSourceState,
    activeGithubTaskKind,
    githubWorkItemMutation
  } = model
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
        {
          repoId: repo.id,
          sourceContext: getTaskPageRepoSourceContext(repo, 'github')
        }
      ).then((checks) => {
        patchTaskPageWorkItemRows(
          {
            id: item.id,
            repoId: item.repoId
          },
          {
            checksSummary: deriveTaskPagePRCheckSummary(checks)
          },
          (currentItem) =>
            currentItem.type === 'pr' &&
            currentItem.headSha === requestedHeadSha &&
            sameOptionalGitHubOwnerRepo(currentItem.prRepo, requestedPRRepo)
        )
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

  // Why: load only the clicked page so a high-page jump doesn't exhaust GitHub's Search API rate bucket.
  const nextModel = model as typeof model & {
    applyTypeFilter: typeof applyTypeFilter
    currentPageItems: typeof currentPageItems
    typeFilteredCurrentPageItems: typeof typeFilteredCurrentPageItems
    filteredWorkItems: typeof filteredWorkItems
    softHiddenVisibleCount: typeof softHiddenVisibleCount
    showGitHubTaskSkeletons: typeof showGitHubTaskSkeletons
    loadedGitHubAuthorLogins: typeof loadedGitHubAuthorLogins
    primaryGithubFilterSlug: typeof primaryGithubFilterSlug
    showPRManagementColumns: typeof showPRManagementColumns
    githubTaskGridClass: typeof githubTaskGridClass
    ensurePRChecksLoaded: typeof ensurePRChecksLoaded
    lastLoadedPageIndex: typeof lastLoadedPageIndex
    lastLoadedPageFull: typeof lastLoadedPageFull
    fallbackTotalPages: typeof fallbackTotalPages
    totalPages: typeof totalPages
  }
  nextModel.applyTypeFilter = applyTypeFilter
  nextModel.currentPageItems = currentPageItems
  nextModel.typeFilteredCurrentPageItems = typeFilteredCurrentPageItems
  nextModel.filteredWorkItems = filteredWorkItems
  nextModel.softHiddenVisibleCount = softHiddenVisibleCount
  nextModel.showGitHubTaskSkeletons = showGitHubTaskSkeletons
  nextModel.loadedGitHubAuthorLogins = loadedGitHubAuthorLogins
  nextModel.primaryGithubFilterSlug = primaryGithubFilterSlug
  nextModel.showPRManagementColumns = showPRManagementColumns
  nextModel.githubTaskGridClass = githubTaskGridClass
  nextModel.ensurePRChecksLoaded = ensurePRChecksLoaded
  nextModel.lastLoadedPageIndex = lastLoadedPageIndex
  nextModel.lastLoadedPageFull = lastLoadedPageFull
  nextModel.fallbackTotalPages = fallbackTotalPages
  nextModel.totalPages = totalPages
  return nextModel
}
export type TaskPageGitHubListProjectionModel = ReturnType<typeof useTaskPageGitHubListProjection>
