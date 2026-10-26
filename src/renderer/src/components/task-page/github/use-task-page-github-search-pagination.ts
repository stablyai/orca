import type { TaskPageGitHubListProjectionModel } from './use-task-page-github-list-projection'
import { useCallback, useEffect } from 'react'
import { stripRepoQualifiers } from '../../../../../shared/task-query'
import { taskPageToGitHubApiPage } from '../../../../../shared/work-items'
import {
  resolveEmptyPageOutcome,
  applyWindowPageLimit,
  applyEmptyPageClamp
} from '@/components/task-page/task-page-work-item-pagination'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { overlayPendingOnTaskPagePages } from '@/components/task-page/github/task-page-github-work-item-mutation-pages'
import { scopeGitHubTaskSearch } from '../../../../../shared/task-github-search'
import { useGitHubTaskSearchCommit } from '@/components/use-github-task-search-commit'
import { getTaskPageRepoSourceContext } from '../task-page-source-context'
export function useTaskPageGitHubSearchPagination(model: TaskPageGitHubListProjectionModel) {
  const {
    setTaskResumeState,
    selectedRepos,
    githubSearchPersistReadyRef,
    taskResumeApplied,
    taskSearchInput,
    appliedTaskSearch,
    setAppliedTaskSearch,
    activeTaskPreset,
    setTasksFiltering,
    paginationGenerationRef,
    githubPerRepoPageLimit,
    githubPageSize,
    setPages,
    currentPage,
    setCurrentPage,
    pagesRef,
    currentPageRef,
    paginationLoading,
    setPaginationLoading,
    setLoadingTargetPage,
    setCountedTotalPages,
    setProvenPageLimit,
    countedTotalPagesRef,
    fetchWorkItemsNextPage,
    activeGithubTaskKind
  } = model
  // Why: load only the clicked page so a high-page jump doesn't exhaust GitHub's Search API rate bucket.
  const handleLoadNextPage = useCallback(
    async (targetPage?: number) => {
      if (paginationLoading || selectedRepos.length === 0) {
        return
      }
      const q = stripRepoQualifiers(appliedTaskSearch.trim())
      const repoArgs = selectedRepos.map((r) => ({
        repoId: r.id,
        path: r.path,
        executionHostId: r.executionHostId,
        sourceContext: getTaskPageRepoSourceContext(r, 'github')
      }))
      const requestGeneration = paginationGenerationRef.current
      const target = targetPage ?? currentPage + 1
      setPaginationLoading(true)
      setLoadingTargetPage(target)
      try {
        const { items, failedCount, errorTypes } = await fetchWorkItemsNextPage(
          repoArgs,
          githubPerRepoPageLimit,
          githubPageSize,
          q,
          taskPageToGitHubApiPage(target)
        )
        if (paginationGenerationRef.current !== requestGeneration) {
          return
        }
        if (items.length === 0) {
          // Derive the count-independent failure reason now, but clamp against committed count in the updater.
          const { reason } = resolveEmptyPageOutcome({
            target,
            failedCount,
            errorTypes,
            countedTotalPages: null
          })
          if (reason === 'window-unreachable') {
            toast.error(
              translate(
                'auto.components.TaskPage.loadPageUnreachable',
                'Page {{value0}} is beyond what GitHub search can return.',
                {
                  value0: String(target + 1)
                }
              ),
              {
                id: 'work-items-page-unreachable'
              }
            )
            setProvenPageLimit((previous) => applyWindowPageLimit(previous, target))
          } else if (reason === 'load-failed') {
            toast.error(
              translate(
                'auto.components.TaskPage.loadPageFailed',
                'Page {{value0}} could not be loaded from GitHub.',
                {
                  value0: String(target + 1)
                }
              ),
              {
                id: 'work-items-page-load-failed'
              }
            )
          } else {
            // Real counts block speculative clamps; use the committed-count ref to explain clean empty clicks without a false failure.
            const committedCount = countedTotalPagesRef.current
            if (committedCount !== null && committedCount > 0) {
              toast(
                translate(
                  'auto.components.TaskPage.loadPageNoMoreResults',
                  'No more results on page {{value0}}.',
                  {
                    value0: String(target + 1)
                  }
                ),
                {
                  id: 'work-items-page-no-more-results'
                }
              )
            }
            const next = applyEmptyPageClamp(committedCount, {
              target,
              failedCount,
              errorTypes
            })
            countedTotalPagesRef.current = next
            setCountedTotalPages(next)
          }
          return
        }
        const nextPages = [...pagesRef.current]
        while (nextPages.length <= target) {
          nextPages.push(null)
        }
        nextPages[target] = overlayPendingOnTaskPagePages([items])[0] ?? []
        pagesRef.current = nextPages
        currentPageRef.current = target
        setPages(nextPages)
        setCurrentPage(target)
      } catch (err) {
        console.error('Failed to load next page:', err)
      } finally {
        if (paginationGenerationRef.current === requestGeneration) {
          setPaginationLoading(false)
          setLoadingTargetPage(null)
        }
      }
    },
    [
      paginationLoading,
      selectedRepos,
      currentPage,
      appliedTaskSearch,
      fetchWorkItemsNextPage,
      githubPageSize,
      githubPerRepoPageLimit,
      setCountedTotalPages,
      paginationGenerationRef,
      setPaginationLoading,
      setCurrentPage,
      currentPageRef,
      pagesRef,
      setProvenPageLimit,
      setLoadingTargetPage,
      countedTotalPagesRef,
      setPages
    ]
  )
  const commitTaskSearch = useCallback(
    (value: string): void => {
      const scoped = scopeGitHubTaskSearch(value, activeGithubTaskKind)
      if (scoped !== appliedTaskSearch) {
        setTasksFiltering(true)
      }
      setAppliedTaskSearch(scoped)
    },
    [activeGithubTaskKind, appliedTaskSearch, setTasksFiltering, setAppliedTaskSearch]
  )
  useGitHubTaskSearchCommit({
    enabled: taskResumeApplied,
    onCommit: commitTaskSearch,
    value: taskSearchInput
  })
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!githubSearchPersistReadyRef.current) {
      githubSearchPersistReadyRef.current = true
      return
    }
    // Why: persist the applied query unconditionally to cover paths that change appliedTaskSearch outside the preset handler.
    setTaskResumeState({
      githubItemsPreset: activeTaskPreset,
      githubItemsQuery: appliedTaskSearch.trim()
    })
  }, [
    activeTaskPreset,
    appliedTaskSearch,
    setTaskResumeState,
    taskResumeApplied,
    githubSearchPersistReadyRef
  ])
  const nextModel = model as typeof model & {
    handleLoadNextPage: typeof handleLoadNextPage
    commitTaskSearch: typeof commitTaskSearch
  }
  nextModel.handleLoadNextPage = handleLoadNextPage
  nextModel.commitTaskSearch = commitTaskSearch
  return nextModel
}
export type TaskPageGitHubSearchPaginationModel = ReturnType<
  typeof useTaskPageGitHubSearchPagination
>
