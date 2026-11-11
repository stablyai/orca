import { useTaskPageGitHubCollectionState } from './use-task-page-github-collection-state'
import type { TaskPageProviderStateModel } from '../use-task-page-provider-state'
import { useState, useRef, useEffect, useLayoutEffect, useSyncExternalStore } from 'react'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'
import {
  PER_REPO_FETCH_LIMIT,
  CROSS_REPO_DISPLAY_LIMIT,
  getTaskPagePerRepoLimit
} from '../../../../../shared/work-items/work-item-pagination'
import { taskPageGitHubResumeCache } from '@/components/task-page/github/task-page-github-resume-cache'
import { githubTaskBinding } from '@/lib/work-items/github/github-task-observation'
import { useAppStore } from '@/store/index'
import type { GitHubListRestoreWrite } from './task-page-github-list-scroll-restore'
export function useTaskPageGitHubListState(model: TaskPageProviderStateModel) {
  const {
    pageData,
    getCachedWorkItems,
    workItemsInvalidationNonce,
    selectedRepos,
    selectedReposKey: repoSelectionKey,
    defaultTaskViewPreset,
    initialTaskQuery,
    taskSource,
    taskResumeApplied,
    githubMode
  } = model
  const collections = useAppStore((s) => s.githubSourceCollections)
  // Why a string snapshot: only the selected owners' lifetimes re-render this view, not other owners' publications.
  const ownerContexts = useSyncExternalStore(collections.subscribe, () =>
    JSON.stringify(selectedRepos.map((repo) => collections.context(repo)))
  )
  const selectedReposKey =
    taskSource === 'github'
      ? JSON.stringify([repoSelectionKey, selectedRepos.map(githubTaskBinding), ownerContexts])
      : repoSelectionKey
  const [taskSearchInput, setTaskSearchInput] = useState(initialTaskQuery)
  const [appliedTaskSearch, setAppliedTaskSearch] = useState(initialTaskQuery)
  const taskSearchInputRef = useRef<HTMLInputElement>(null)
  const [activeTaskPreset, setActiveTaskPreset] = useState<TaskViewPresetId | null>(
    defaultTaskViewPreset
  )
  const [tasksLoading, setTasksLoading] = useState(false)
  // The request key the latest landing run dispatched for; a different current key means a request is owed.
  const [landingRequestKey, setLandingRequestKey] = useState('')
  const [tasksRefreshing, setTasksRefreshing] = useState(false)
  const [tasksFiltering, setTasksFiltering] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  // Why: per-repo failure count for the "N of M" banner; IPC rejections use tasksError instead so partial-failure and hard-reject don't double-show.
  const [failedCount, setFailedCount] = useState(0)
  // Why: when every refresh fails (GitHub outage/network/rate limit), attribute it to GitHub instead of showing an empty or stale list as current.
  const [githubUnavailable, setGithubUnavailable] = useState(false)
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
  // Quiet success refreshes avoid the filter nonce/skeleton so membership exits do not blank the list.
  const [quietRefreshNonce, setQuietRefreshNonce] = useState(0)
  const [githubViewerLogin, setGitHubViewerLogin] = useState<string | null>(null)
  // Distinguish explicit refresh nonce changes from repo/filter reruns while the nonce is already positive.
  const lastFetchedNonceRef = useRef(-1)
  // Why: invalidation-nonce analog of lastFetchedNonceRef; a preference flip must force past fetch-dedupe or the fan-out collapses onto a stale in-flight request from the pre-flip source.
  const lastFetchedInvalidationNonceRef = useRef(0)
  const paginationGenerationRef = useRef(0)
  // Why: entering Tasks with fresh cache still verifies remote status once, reconciled into existing rows to avoid a full table shuffle.
  const landingGitHubRefreshKeysRef = useRef<ReadonlySet<string>>(new Set())
  // Why: split the display budget across repos so one provider page maps to one UI page without truncating rows later pages can't return.
  const githubPerRepoPageLimit = getTaskPagePerRepoLimit(
    selectedRepos.length,
    PER_REPO_FETCH_LIMIT,
    CROSS_REPO_DISPLAY_LIMIT
  )
  const githubPageSize = githubPerRepoPageLimit * Math.max(1, selectedRepos.length)
  const { githubResumeContextKey, pages, setPages, countedTotalPages, setCountedTotalPages } =
    useTaskPageGitHubCollectionState({
      collections,
      selectedRepos,
      selectedReposKey,
      initialTaskQuery,
      getCachedWorkItems,
      appliedTaskSearch,
      githubPageSize,
      githubPerRepoPageLimit
    })
  const [currentPage, setCurrentPage] = useState(0)
  const pagesRef = useRef(pages)
  const currentPageRef = useRef(currentPage)
  // Fetch callbacks need the latest paging window immediately after render.
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  pagesRef.current = pages
  // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
  currentPageRef.current = currentPage
  const githubResumeConsumedRef = useRef(false)
  const githubResumeContextRef = useRef('')
  const githubListScrollRef = useRef<HTMLDivElement>(null)
  const githubListScrollTopRef = useRef(0)
  const pendingGithubScrollRestoreRef = useRef<number | null>(null)
  const githubListRestoreWriteRef = useRef<GitHubListRestoreWrite | null>(null)
  const [paginationLoading, setPaginationLoading] = useState(false)
  const [loadingTargetPage, setLoadingTargetPage] = useState<number | null>(null)
  // Keep proven 422 limits separate so late counts replace speculation without resurrecting unreachable pages.
  const [provenPageLimit, setProvenPageLimit] = useState<number | null>(null)
  // Mirror committed counts synchronously so empty-page handling cannot use a stale click-time closure.
  // Why every commit: the count also changes from store publications and collection switches, not only its setter.
  const countedTotalPagesRef = useRef<number | null>(null)
  useLayoutEffect(() => {
    countedTotalPagesRef.current = countedTotalPages
  })
  const hardRefreshEpochRef = useRef(0)
  const fetchWorkItemsNextPage = useAppStore((s) => s.fetchWorkItemsNextPage)
  const countWorkItemsAcrossRepos = useAppStore((s) => s.countWorkItemsAcrossRepos)
  useEffect(() => {
    const page = pages[currentPage]
    if (!taskResumeApplied || taskSource !== 'github' || githubMode !== 'items' || !page) {
      return
    }
    taskPageGitHubResumeCache.write(
      githubResumeContextKey,
      currentPage,
      page,
      undefined,
      selectedRepos.map((repo) => collections.context(repo))
    )
  }, [
    collections,
    selectedRepos,
    currentPage,
    githubMode,
    githubResumeContextKey,
    pages,
    taskResumeApplied,
    taskSource
  ])
  const taskListPositionRef = useRef<{
    contextKey: string
    page: number
    scrollTop: number
  } | null>(null)
  useLayoutEffect(() => {
    if (
      taskSource !== 'github' ||
      githubMode !== 'items' ||
      pageData.openGitHubWorkItem ||
      pendingGithubScrollRestoreRef.current !== null
    ) {
      return
    }
    taskListPositionRef.current = {
      contextKey: githubResumeContextKey,
      page: currentPage,
      scrollTop: githubListScrollTopRef.current
    }
  }, [currentPage, githubMode, githubResumeContextKey, pageData.openGitHubWorkItem, taskSource])
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

  // Key generations by request fields rather than fresh repo arrays so background refreshes cannot discard page navigation.
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
    taskResumeApplied
  ])

  // Why: the dialog's "Use" button routes through the same direct-launch flow as the row-level "Use" CTA so behavior is consistent regardless of entry point.
  return Object.assign(model, {
    selectedReposKey,
    taskSearchInput,
    setTaskSearchInput,
    appliedTaskSearch,
    setAppliedTaskSearch,
    taskSearchInputRef,
    activeTaskPreset,
    setActiveTaskPreset,
    tasksLoading,
    setTasksLoading,
    landingRequestKey,
    setLandingRequestKey,
    tasksRefreshing,
    setTasksRefreshing,
    tasksFiltering,
    setTasksFiltering,
    tasksError,
    setTasksError,
    failedCount,
    setFailedCount,
    githubUnavailable,
    setGithubUnavailable,
    taskRefreshNonce,
    setTaskRefreshNonce,
    quietRefreshNonce,
    setQuietRefreshNonce,
    githubViewerLogin,
    setGitHubViewerLogin,
    lastFetchedNonceRef,
    lastFetchedInvalidationNonceRef,
    paginationGenerationRef,
    landingGitHubRefreshKeysRef,
    githubPerRepoPageLimit,
    githubPageSize,
    githubResumeContextKey,
    pages,
    setPages,
    currentPage,
    setCurrentPage,
    pagesRef,
    currentPageRef,
    githubResumeConsumedRef,
    githubResumeContextRef,
    githubListScrollRef,
    githubListScrollTopRef,
    pendingGithubScrollRestoreRef,
    githubListRestoreWriteRef,
    paginationLoading,
    setPaginationLoading,
    loadingTargetPage,
    setLoadingTargetPage,
    countedTotalPages,
    setCountedTotalPages,
    provenPageLimit,
    setProvenPageLimit,
    countedTotalPagesRef,
    hardRefreshEpochRef,
    fetchWorkItemsNextPage,
    countWorkItemsAcrossRepos,
    taskListPositionRef
  })
}
export type TaskPageGitHubListStateModel = ReturnType<typeof useTaskPageGitHubListState>
