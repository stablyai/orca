import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { toast } from 'sonner'

import { overlayPendingOnTaskPagePages } from '@/components/task-page-github-work-item-mutations'
import { getTaskPageRepoSourceContext } from '@/components/task-page/source/repo-source-context'
import {
  applyEmptyPageClamp,
  applyWindowPageLimit,
  resolveEmptyPageOutcome,
  taskPageToGitHubApiPage
} from '@/components/task-page-work-item-pagination'
import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import { stripRepoQualifiers } from '../../../../../shared/task-query'

export function useTaskPageGitHubPageLoader({
  paginationLoading,
  selectedRepos,
  appliedTaskSearch,
  paginationGenerationRef,
  currentPage,
  setPaginationLoading,
  setLoadingTargetPage,
  fetchWorkItemsNextPage,
  githubPerRepoPageLimit,
  githubPageSize,
  countedTotalPagesRef,
  setProvenPageLimit,
  setCountedTotalPages,
  pagesRef,
  currentPageRef,
  setPages,
  setCurrentPage
}: {
  paginationLoading: boolean
  selectedRepos: Repo[]
  appliedTaskSearch: string
  paginationGenerationRef: MutableRefObject<number>
  currentPage: number
  setPaginationLoading: Dispatch<SetStateAction<boolean>>
  setLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  fetchWorkItemsNextPage: AppState['fetchWorkItemsNextPage']
  githubPerRepoPageLimit: number
  githubPageSize: number
  countedTotalPagesRef: MutableRefObject<number | null>
  setProvenPageLimit: Dispatch<SetStateAction<number | null>>
  setCountedTotalPages: Dispatch<SetStateAction<number | null>>
  pagesRef: MutableRefObject<(GitHubWorkItem[] | null)[]>
  currentPageRef: MutableRefObject<number>
  setPages: Dispatch<SetStateAction<(GitHubWorkItem[] | null)[]>>
  setCurrentPage: Dispatch<SetStateAction<number>>
}) {
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
          // Why: see resolveEmptyPageOutcome — a dead click needs feedback only
          // when something actually failed; a clean empty probe is end-of-data.
          // The reason never depends on the count, so it's safe to derive here;
          // the clamp is not (see applyEmptyPageClamp) and runs in the updater.
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
                { value0: String(target + 1) }
              ),
              { id: 'work-items-page-unreachable' }
            )
            setProvenPageLimit((previous) => applyWindowPageLimit(previous, target))
          } else if (reason === 'load-failed') {
            toast.error(
              translate(
                'auto.components.TaskPage.loadPageFailed',
                'Page {{value0}} could not be loaded from GitHub.',
                { value0: String(target + 1) }
              ),
              { id: 'work-items-page-load-failed' }
            )
          } else {
            // Why: with a real count the clamp is refused, so without feedback
            // the click would look dead — the count over-advertised; nothing
            // failed, so the copy stays neutral. The ref carries the committed
            // count, immune to the click-time closure race.
            const committedCount = countedTotalPagesRef.current
            if (committedCount !== null && committedCount > 0) {
              toast(
                translate(
                  'auto.components.TaskPage.loadPageNoMoreResults',
                  'No more results on page {{value0}}.',
                  { value0: String(target + 1) }
                ),
                { id: 'work-items-page-no-more-results' }
              )
            }
            const next = applyEmptyPageClamp(committedCount, { target, failedCount, errorTypes })
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
        if (paginationGenerationRef.current === requestGeneration) {
          toast.error(
            translate(
              'auto.components.TaskPage.loadPageFailed',
              'Page {{value0}} could not be loaded from GitHub.',
              { value0: String(target + 1) }
            ),
            { id: 'work-items-page-load-failed' }
          )
        }
      } finally {
        if (paginationGenerationRef.current === requestGeneration) {
          setPaginationLoading(false)
          setLoadingTargetPage(null)
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the remaining referenced setters and refs are stable useState/useRef identities passed in as props.
    [
      paginationLoading,
      selectedRepos,
      currentPage,
      appliedTaskSearch,
      fetchWorkItemsNextPage,
      githubPageSize,
      githubPerRepoPageLimit
    ]
  )

  return { handleLoadNextPage }
}
