import type { TaskPageGitHubListProjectionModel } from './use-task-page-github-list-projection'
import { useCallback, useEffect, useRef } from 'react'
import { stripRepoQualifiers } from '../../../../../../shared/work-items/task-query'
import { taskPageToGitHubApiPage } from '../../../../../../shared/work-items/work-item-pagination'
import {
  resolveEmptyPageOutcome,
  applyEmptyPageClamp,
  applyWindowPageLimit
} from '../../../../../../shared/work-items/work-item-empty-page'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { overlayPendingOnTaskPagePages } from '@/components/task-page/github/mutations/task-page-github-work-item-mutation-pages'
import { scopeGitHubTaskSearch } from '../../../../../../shared/work-items/task-github-search'
import { useGitHubTaskSearchCommit } from '@/components/task-page/github/listing/use-github-task-search-commit'
import { getTaskPageGitHubRepoArgs } from '@/components/task-page/task-page-source-context'
import type { TaskViewPresetId } from '../../../../../../shared/ui-chrome/ui-chrome-types'
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
    setActiveTaskPreset,
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
    activeGithubTaskKind,
    unreachableTaskSourceHostIds
  } = model
  const filteredDraftResumeRef = useRef<{
    appliedQuery: string
    githubItemsPreset: TaskViewPresetId | null
    githubItemsQuery: string
  } | null>(null)
  // Why: load only the clicked page so a high-page jump doesn't exhaust GitHub's Search API rate bucket.
  const handleLoadNextPage = useCallback(
    async (targetPage?: number) => {
      if (paginationLoading || selectedRepos.length === 0) {
        return
      }
      const q = stripRepoQualifiers(appliedTaskSearch.trim())
      const repoArgs = getTaskPageGitHubRepoArgs(selectedRepos, unreachableTaskSourceHostIds)
      const requestGeneration = paginationGenerationRef.current
      const target = targetPage ?? currentPage + 1
      setPaginationLoading(true)
      setLoadingTargetPage(target)
      try {
        const result = await fetchWorkItemsNextPage(
          repoArgs,
          githubPerRepoPageLimit,
          githubPageSize,
          q,
          taskPageToGitHubApiPage(target)
        )
        if (!result) {
          return
        }
        const { items, failedCount, errorTypes } = result
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
            if (next !== committedCount) {
              countedTotalPagesRef.current = next
              setCountedTotalPages(next)
            }
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
      unreachableTaskSourceHostIds,
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
      const filteredDraft = filteredDraftResumeRef.current
      filteredDraftResumeRef.current = null
      if (scoped !== appliedTaskSearch) {
        setActiveTaskPreset(
          filteredDraft?.githubItemsQuery === scoped ? filteredDraft.githubItemsPreset : null
        )
        setTasksFiltering(true)
      }
      setAppliedTaskSearch(scoped)
    },
    [
      activeGithubTaskKind,
      appliedTaskSearch,
      setActiveTaskPreset,
      setTasksFiltering,
      setAppliedTaskSearch
    ]
  )
  useGitHubTaskSearchCommit({
    enabled: taskResumeApplied,
    onCommit: commitTaskSearch,
    value: taskSearchInput
  })
  useEffect(() => {
    return () => {
      const resume = filteredDraftResumeRef.current
      if (resume) {
        setTaskResumeState({
          githubItemsPreset: resume.githubItemsPreset,
          githubItemsQuery: resume.githubItemsQuery
        })
      }
    }
  }, [setTaskResumeState])
  useEffect(() => {
    if (!taskResumeApplied) {
      return
    }
    if (!githubSearchPersistReadyRef.current) {
      githubSearchPersistReadyRef.current = true
      return
    }
    if (filteredDraftResumeRef.current?.appliedQuery !== appliedTaskSearch) {
      filteredDraftResumeRef.current = null
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
  return Object.assign(model, { handleLoadNextPage, commitTaskSearch, filteredDraftResumeRef })
}
export type TaskPageGitHubSearchPaginationModel = ReturnType<
  typeof useTaskPageGitHubSearchPagination
>
