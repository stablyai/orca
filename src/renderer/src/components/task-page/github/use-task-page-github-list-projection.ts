import { useCallback, useMemo } from 'react'
import { useGitHubTaskItems } from '@/hooks/useGitHubTaskItems'
import type { TaskPageJiraCreationMetadataModel } from '../jira/use-task-page-jira-creation-metadata'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { taskPageGitHubItemKey } from '@/components/task-page/github/task-page-github-work-item-mutation-keys'
import { deriveAdvertisedTotalPages } from '../../../../../shared/work-items/work-item-empty-page'
import { GITHUB_PR_TASK_GRID_CLASS, GITHUB_TASK_GRID_CLASS } from '../task-page-source-context'
import { useTaskPageGitHubListPending } from './use-task-page-github-list-pending'
import { useTaskPagePRCheckHydration } from './use-task-page-pr-check-hydration'
export function useTaskPageGitHubListProjection(model: TaskPageJiraCreationMetadataModel) {
  const {
    tasksFiltering,
    githubPageSize,
    pages,
    currentPage,
    countedTotalPages,
    provenPageLimit,
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
  const rawCurrentPageItems = useMemo(() => pages[currentPage] ?? [], [pages, currentPage])
  const currentPageItems = useGitHubTaskItems(rawCurrentPageItems)
  const typeFilteredCurrentPageItems = useMemo(
    () => applyTypeFilter(currentPageItems),
    [applyTypeFilter, currentPageItems]
  )
  // Retain membership-exit rows for rollback/cursors while sticky and pending hides remove them from display.
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
  const githubListPending = useTaskPageGitHubListPending(model)
  const showGitHubTaskSkeletons =
    tasksFiltering || (githubListPending && filteredWorkItems.length === 0)
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
  const ensurePRChecksLoaded = useTaskPagePRCheckHydration(
    model,
    filteredWorkItems,
    showPRManagementColumns
  )
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
  return Object.assign(model, {
    applyTypeFilter,
    currentPageItems,
    typeFilteredCurrentPageItems,
    filteredWorkItems,
    softHiddenVisibleCount,
    githubListPending,
    showGitHubTaskSkeletons,
    loadedGitHubAuthorLogins,
    primaryGithubFilterSlug,
    showPRManagementColumns,
    githubTaskGridClass,
    ensurePRChecksLoaded,
    lastLoadedPageIndex,
    lastLoadedPageFull,
    fallbackTotalPages,
    totalPages
  })
}
export type TaskPageGitHubListProjectionModel = ReturnType<typeof useTaskPageGitHubListProjection>
