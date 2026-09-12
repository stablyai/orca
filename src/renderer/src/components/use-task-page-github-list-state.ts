import type { TaskPageProviderStateModel } from './use-task-page-provider-state'
import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import type { TaskViewPresetId } from '../../../shared/ui-chrome-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import { getTaskPagePerRepoLimit } from '@/components/task-page-work-item-pagination'
import { PER_REPO_FETCH_LIMIT, CROSS_REPO_DISPLAY_LIMIT } from '@/lib/new-workspace'
import {
  buildTaskPageGitHubResumeContextKey,
  taskPageGitHubResumeCache
} from '@/components/task-page-github-resume-cache'
import { sortWorkItemsByNumber } from '../../../shared/work-items'
import { useAppStore } from '@/store'
import type { GitHubListRestoreWrite } from './task-page-github-list-scroll-restore'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
export function useTaskPageGitHubListState(model: TaskPageProviderStateModel) {
  const {
    pageData,
    getCachedWorkItems,
    workItemsInvalidationNonce,
    selectedRepos,
    selectedReposKey,
    defaultTaskViewPreset,
    initialTaskQuery,
    taskSource,
    taskResumeApplied,
    githubMode
  } = model
  const [taskSearchInput, setTaskSearchInput] = useState(initialTaskQuery)
  const [appliedTaskSearch, setAppliedTaskSearch] = useState(initialTaskQuery)
  const taskSearchInputRef = useRef<HTMLInputElement>(null)
  const [activeTaskPreset, setActiveTaskPreset] = useState<TaskViewPresetId | null>(
    defaultTaskViewPreset
  )
  const [tasksLoading, setTasksLoading] = useState(false)
  const [tasksRefreshing, setTasksRefreshing] = useState(false)
  const [tasksFiltering, setTasksFiltering] = useState(false)
  const [tasksError, setTasksError] = useState<string | null>(null)
  // Why: per-repo failure count for the "N of M" banner; IPC rejections use tasksError instead so partial-failure and hard-reject don't double-show.
  const [failedCount, setFailedCount] = useState(0)
  // Why: when every refresh fails (GitHub outage/network/rate limit), attribute it to GitHub instead of showing an empty or stale list as current.
  const [githubUnavailable, setGithubUnavailable] = useState(false)
  const [taskRefreshNonce, setTaskRefreshNonce] = useState(0)
  // Why: quiet success revalidate must never share taskRefreshNonce / tasksFiltering
  // (K23) — membership exits and merge success refresh without filter skeletons.
  const [quietRefreshNonce, setQuietRefreshNonce] = useState(0)
  const [githubViewerLogin, setGitHubViewerLogin] = useState<string | null>(null)
  // Why: the fetch effect uses this to detect when a nonce bump is from the
  // user clicking the refresh button (force=true) vs. re-running for any
  // other reason — e.g. a repo change while the nonce happens to be > 0.
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
  const githubResumeContextKey = buildTaskPageGitHubResumeContextKey({
    selectedReposKey,
    query: appliedTaskSearch.trim(),
    pageSize: githubPageSize
  })
  // Why: null entries are pages not fetched yet; numbered provider pages let a high-page click load directly without reading intermediate pages.
  const [pages, setPages] = useState<(GitHubWorkItem[] | null)[]>(() => {
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
      return [[]]
    }
    const page0 = sortWorkItemsByNumber(merged).slice(0, githubPageSize)
    return [page0]
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
  const [countedTotalPages, setCountedTotalPages] = useState<number | null>(null)
  // Proven window-422 page limit — separate from the count so a late count
  // can't resurrect proven-unreachable pages, nor be pinned by a speculative
  // withdrawal (see deriveAdvertisedTotalPages).
  const [provenPageLimit, setProvenPageLimit] = useState<number | null>(null)
  // Why: synchronous mirror of countedTotalPages — the empty-page branch needs
  // the committed value, not a click-time closure, and refs update immediately.
  const countedTotalPagesRef = useRef<number | null>(null)
  const hardRefreshEpochRef = useRef(0)
  const fetchWorkItemsNextPage = useAppStore((s) => s.fetchWorkItemsNextPage)
  const countWorkItemsAcrossRepos = useAppStore((s) => s.countWorkItemsAcrossRepos)
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
    taskResumeApplied
  ])

  // Why: the dialog's "Use" button routes through the same direct-launch flow as the row-level "Use" CTA so behavior is consistent regardless of entry point.
  const nextModel = model as typeof model & {
    taskSearchInput: typeof taskSearchInput
    setTaskSearchInput: typeof setTaskSearchInput
    appliedTaskSearch: typeof appliedTaskSearch
    setAppliedTaskSearch: typeof setAppliedTaskSearch
    taskSearchInputRef: typeof taskSearchInputRef
    activeTaskPreset: typeof activeTaskPreset
    setActiveTaskPreset: typeof setActiveTaskPreset
    tasksLoading: typeof tasksLoading
    setTasksLoading: typeof setTasksLoading
    tasksRefreshing: typeof tasksRefreshing
    setTasksRefreshing: typeof setTasksRefreshing
    tasksFiltering: typeof tasksFiltering
    setTasksFiltering: typeof setTasksFiltering
    tasksError: typeof tasksError
    setTasksError: typeof setTasksError
    failedCount: typeof failedCount
    setFailedCount: typeof setFailedCount
    githubUnavailable: typeof githubUnavailable
    setGithubUnavailable: typeof setGithubUnavailable
    taskRefreshNonce: typeof taskRefreshNonce
    setTaskRefreshNonce: typeof setTaskRefreshNonce
    quietRefreshNonce: typeof quietRefreshNonce
    setQuietRefreshNonce: typeof setQuietRefreshNonce
    githubViewerLogin: typeof githubViewerLogin
    setGitHubViewerLogin: typeof setGitHubViewerLogin
    lastFetchedNonceRef: typeof lastFetchedNonceRef
    lastFetchedInvalidationNonceRef: typeof lastFetchedInvalidationNonceRef
    paginationGenerationRef: typeof paginationGenerationRef
    landingGitHubRefreshKeysRef: typeof landingGitHubRefreshKeysRef
    githubPerRepoPageLimit: typeof githubPerRepoPageLimit
    githubPageSize: typeof githubPageSize
    githubResumeContextKey: typeof githubResumeContextKey
    pages: typeof pages
    setPages: typeof setPages
    currentPage: typeof currentPage
    setCurrentPage: typeof setCurrentPage
    pagesRef: typeof pagesRef
    currentPageRef: typeof currentPageRef
    githubResumeConsumedRef: typeof githubResumeConsumedRef
    githubResumeContextRef: typeof githubResumeContextRef
    githubListScrollRef: typeof githubListScrollRef
    githubListScrollTopRef: typeof githubListScrollTopRef
    pendingGithubScrollRestoreRef: typeof pendingGithubScrollRestoreRef
    githubListRestoreWriteRef: typeof githubListRestoreWriteRef
    paginationLoading: typeof paginationLoading
    setPaginationLoading: typeof setPaginationLoading
    loadingTargetPage: typeof loadingTargetPage
    setLoadingTargetPage: typeof setLoadingTargetPage
    countedTotalPages: typeof countedTotalPages
    setCountedTotalPages: typeof setCountedTotalPages
    provenPageLimit: typeof provenPageLimit
    setProvenPageLimit: typeof setProvenPageLimit
    countedTotalPagesRef: typeof countedTotalPagesRef
    hardRefreshEpochRef: typeof hardRefreshEpochRef
    fetchWorkItemsNextPage: typeof fetchWorkItemsNextPage
    countWorkItemsAcrossRepos: typeof countWorkItemsAcrossRepos
    taskListPositionRef: typeof taskListPositionRef
  }
  nextModel.taskSearchInput = taskSearchInput
  nextModel.setTaskSearchInput = setTaskSearchInput
  nextModel.appliedTaskSearch = appliedTaskSearch
  nextModel.setAppliedTaskSearch = setAppliedTaskSearch
  nextModel.taskSearchInputRef = taskSearchInputRef
  nextModel.activeTaskPreset = activeTaskPreset
  nextModel.setActiveTaskPreset = setActiveTaskPreset
  nextModel.tasksLoading = tasksLoading
  nextModel.setTasksLoading = setTasksLoading
  nextModel.tasksRefreshing = tasksRefreshing
  nextModel.setTasksRefreshing = setTasksRefreshing
  nextModel.tasksFiltering = tasksFiltering
  nextModel.setTasksFiltering = setTasksFiltering
  nextModel.tasksError = tasksError
  nextModel.setTasksError = setTasksError
  nextModel.failedCount = failedCount
  nextModel.setFailedCount = setFailedCount
  nextModel.githubUnavailable = githubUnavailable
  nextModel.setGithubUnavailable = setGithubUnavailable
  nextModel.taskRefreshNonce = taskRefreshNonce
  nextModel.setTaskRefreshNonce = setTaskRefreshNonce
  nextModel.quietRefreshNonce = quietRefreshNonce
  nextModel.setQuietRefreshNonce = setQuietRefreshNonce
  nextModel.githubViewerLogin = githubViewerLogin
  nextModel.setGitHubViewerLogin = setGitHubViewerLogin
  nextModel.lastFetchedNonceRef = lastFetchedNonceRef
  nextModel.lastFetchedInvalidationNonceRef = lastFetchedInvalidationNonceRef
  nextModel.paginationGenerationRef = paginationGenerationRef
  nextModel.landingGitHubRefreshKeysRef = landingGitHubRefreshKeysRef
  nextModel.githubPerRepoPageLimit = githubPerRepoPageLimit
  nextModel.githubPageSize = githubPageSize
  nextModel.githubResumeContextKey = githubResumeContextKey
  nextModel.pages = pages
  nextModel.setPages = setPages
  nextModel.currentPage = currentPage
  nextModel.setCurrentPage = setCurrentPage
  nextModel.pagesRef = pagesRef
  nextModel.currentPageRef = currentPageRef
  nextModel.githubResumeConsumedRef = githubResumeConsumedRef
  nextModel.githubResumeContextRef = githubResumeContextRef
  nextModel.githubListScrollRef = githubListScrollRef
  nextModel.githubListScrollTopRef = githubListScrollTopRef
  nextModel.pendingGithubScrollRestoreRef = pendingGithubScrollRestoreRef
  nextModel.githubListRestoreWriteRef = githubListRestoreWriteRef
  nextModel.paginationLoading = paginationLoading
  nextModel.setPaginationLoading = setPaginationLoading
  nextModel.loadingTargetPage = loadingTargetPage
  nextModel.setLoadingTargetPage = setLoadingTargetPage
  nextModel.countedTotalPages = countedTotalPages
  nextModel.setCountedTotalPages = setCountedTotalPages
  nextModel.provenPageLimit = provenPageLimit
  nextModel.setProvenPageLimit = setProvenPageLimit
  nextModel.countedTotalPagesRef = countedTotalPagesRef
  nextModel.hardRefreshEpochRef = hardRefreshEpochRef
  nextModel.fetchWorkItemsNextPage = fetchWorkItemsNextPage
  nextModel.countWorkItemsAcrossRepos = countWorkItemsAcrossRepos
  nextModel.taskListPositionRef = taskListPositionRef
  return nextModel
}
export type TaskPageGitHubListStateModel = ReturnType<typeof useTaskPageGitHubListState>
