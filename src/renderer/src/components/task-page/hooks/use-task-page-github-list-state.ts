import { useLayoutEffect, useRef, useState } from 'react'

import { useAppStore } from '@/store'
import { PER_REPO_FETCH_LIMIT, CROSS_REPO_DISPLAY_LIMIT } from '@/lib/new-workspace'
import { getTaskPageRepoSourceContext } from '@/components/task-page/source/repo-source-context'
import { buildTaskPageGitHubResumeContextKey } from '@/components/task-page-github-resume-cache'
import { getTaskPagePerRepoLimit } from '@/components/task-page-work-item-pagination'
import { sortWorkItemsByNumber } from '../../../../../shared/work-items'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskViewPresetId } from '../../../../../shared/ui-chrome-types'
import type { AppState } from '@/store/types'

export function useTaskPageGitHubListState({
  initialTaskQuery,
  defaultTaskViewPreset,
  selectedRepos,
  selectedReposKey,
  getCachedWorkItems
}: {
  initialTaskQuery: string
  defaultTaskViewPreset: TaskViewPresetId
  selectedRepos: readonly Repo[]
  selectedReposKey: string
  getCachedWorkItems: AppState['getCachedWorkItems']
}) {
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
  useLayoutEffect(() => {
    // Why: effects and event handlers read these refs; a render-phase write can publish a discarded render.
    pagesRef.current = pages
    currentPageRef.current = currentPage
  }, [pages, currentPage])
  const githubResumeConsumedRef = useRef(false)
  const githubResumeContextRef = useRef('')
  const githubListScrollRef = useRef<HTMLDivElement>(null)
  const githubListScrollTopRef = useRef(0)
  const pendingGithubScrollRestoreRef = useRef<number | null>(null)
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

  return {
    taskSearchInput,
    setTaskSearchInput,
    appliedTaskSearch,
    setAppliedTaskSearch,
    taskSearchInputRef,
    activeTaskPreset,
    setActiveTaskPreset,
    tasksLoading,
    setTasksLoading,
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
    countWorkItemsAcrossRepos
  }
}
