import {
  useEffect,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction
} from 'react'

import { useAppStore } from '@/store'
import { taskPageGitHubResumeCache } from '@/components/task-page-github-resume-cache'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskProvider } from '../../../../../shared/task-providers'

export function useTaskPageGitHubListResume({
  pages,
  currentPage,
  githubResumeContextKey,
  taskResumeApplied,
  taskSource,
  githubMode,
  openGitHubWorkItem,
  githubListScrollRef,
  githubListScrollTopRef,
  pendingGithubScrollRestoreRef,
  paginationGenerationRef,
  setPaginationLoading,
  setLoadingTargetPage,
  selectedReposKey,
  appliedTaskSearch,
  workItemsInvalidationNonce,
  taskRefreshNonce,
  dialogWorkItem
}: {
  pages: (GitHubWorkItem[] | null)[]
  currentPage: number
  githubResumeContextKey: string
  taskResumeApplied: boolean
  taskSource: TaskProvider
  githubMode: 'items' | 'project'
  openGitHubWorkItem: GitHubWorkItem | undefined
  githubListScrollRef: RefObject<HTMLDivElement | null>
  githubListScrollTopRef: MutableRefObject<number>
  pendingGithubScrollRestoreRef: MutableRefObject<number | null>
  paginationGenerationRef: MutableRefObject<number>
  setPaginationLoading: Dispatch<SetStateAction<boolean>>
  setLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  selectedReposKey: string
  appliedTaskSearch: string
  workItemsInvalidationNonce: number
  taskRefreshNonce: number
  dialogWorkItem: GitHubWorkItem | null
}) {
  useEffect(() => {
    const page = pages[currentPage]
    if (!taskResumeApplied || taskSource !== 'github' || githubMode !== 'items' || !page) {
      return
    }
    taskPageGitHubResumeCache.write(githubResumeContextKey, currentPage, page)
  }, [currentPage, githubMode, githubResumeContextKey, pages, taskResumeApplied, taskSource])

  const taskListPositionRef = useRef<{
    contextKey: string
    page: number
    scrollTop: number
  } | null>(null)

  useLayoutEffect(() => {
    if (
      taskSource !== 'github' ||
      githubMode !== 'items' ||
      openGitHubWorkItem ||
      pendingGithubScrollRestoreRef.current !== null
    ) {
      return
    }
    taskListPositionRef.current = {
      contextKey: githubResumeContextKey,
      page: currentPage,
      scrollTop: githubListScrollTopRef.current
    }
  }, [
    currentPage,
    githubMode,
    githubResumeContextKey,
    openGitHubWorkItem,
    taskSource,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef
  ])

  useEffect(
    () => () => {
      const position = taskListPositionRef.current
      const state = useAppStore.getState()
      if (position && !state.taskPageData.openGitHubWorkItem) {
        state.setTaskListPosition({
          contextKey: position.contextKey,
          page: position.page,
          scrollTop: position.scrollTop
        })
      }
    },
    []
  )

  // Why: keyed on selectedReposKey, not the selectedRepos array — a background
  // repos:changed refresh mid-flight would otherwise bump the generation and
  // silently discard the user's page navigation (#11485). Mirrors every dep of
  // the fetch effect that resets page state, so a reset always invalidates
  // in-flight page requests.
  useEffect(() => {
    paginationGenerationRef.current += 1
    setPaginationLoading(false)
    setLoadingTargetPage(null)
  }, [
    selectedReposKey,
    appliedTaskSearch,
    workItemsInvalidationNonce,
    taskRefreshNonce,
    taskSource,
    githubMode,
    taskResumeApplied,

    setPaginationLoading,
    paginationGenerationRef,
    setLoadingTargetPage
  ])

  useLayoutEffect(() => {
    const scrollTop = pendingGithubScrollRestoreRef.current
    const scrollElement = githubListScrollRef.current
    if (scrollTop === null || !scrollElement || !pages[currentPage]) {
      return
    }
    let frame: number | null = null
    let timeout: number | null = null
    let observer: ResizeObserver | null = null
    const clearScheduledRestore = (): void => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame)
        frame = null
      }
      if (timeout !== null) {
        window.clearTimeout(timeout)
        timeout = null
      }
      observer?.disconnect()
    }
    const restore = (): void => {
      const committedScrollElement = githubListScrollRef.current
      if (!committedScrollElement || pendingGithubScrollRestoreRef.current !== scrollTop) {
        return
      }
      committedScrollElement.scrollTop = scrollTop
      githubListScrollTopRef.current = scrollTop
      taskListPositionRef.current = {
        contextKey: githubResumeContextKey,
        page: currentPage,
        scrollTop
      }
      if (Math.abs(committedScrollElement.scrollTop - scrollTop) < 1) {
        pendingGithubScrollRestoreRef.current = null
        clearScheduledRestore()
      }
    }
    observer = new ResizeObserver(restore)
    for (const child of scrollElement.children) {
      observer.observe(child)
    }
    restore()
    if (pendingGithubScrollRestoreRef.current === scrollTop) {
      frame = window.requestAnimationFrame(restore)
      timeout = window.setTimeout(() => {
        if (pendingGithubScrollRestoreRef.current === scrollTop) {
          const committedScrollTop = githubListScrollRef.current?.scrollTop ?? 0
          githubListScrollTopRef.current = committedScrollTop
          taskListPositionRef.current = {
            contextKey: githubResumeContextKey,
            page: currentPage,
            scrollTop: committedScrollTop
          }
          pendingGithubScrollRestoreRef.current = null
        }
        clearScheduledRestore()
      }, 5_000)
    }
    return clearScheduledRestore
  }, [
    currentPage,
    dialogWorkItem,
    githubResumeContextKey,
    pages,
    githubListScrollRef.current?.scrollTop,
    githubListScrollRef,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef
  ])

  return {
    taskListPositionRef
  }
}
