import { useCallback, useEffect, useMemo, type Dispatch, type SetStateAction } from 'react'

import { filterLinearIssuesBySearchQuery } from '@/components/task-page-linear-in-orca-issues'
import {
  compareLinearIssues,
  type LinearProjectTab
} from '@/components/task-page/linear/linear-issue-grouping'
import { LINEAR_ITEM_LIMIT } from '@/components/task-page/task-page-list-limits'
import type { LinearMode, LinearOrderBy } from '@/components/task-page-localized-options'
import {
  LINEAR_ISSUE_LIST_MAX,
  clampLinearIssueListLimit
} from '../../../../../shared/linear/issue-read-limits'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCustomViewSummary,
  LinearProjectSummary
} from '../../../../../shared/linear/project-types'

export function useTaskPageLinearIssuePaging({
  linearMode,
  displayedLinearIssues,
  appliedLinearSearch,
  activeLinearIssueContextLabel,
  linearTeamSelection,
  linearOrderBy,
  activeLinearIssueCanRequestMore,
  activeLinearIssuePage,
  activeLinearIssueError,
  activeLinearIssueLoading,
  activeLinearIssues,
  selectedLinearProject,
  linearProjectTab,
  selectedLinearCustomView,
  setLinearProjectIssuePage,
  setLinearCustomViewIssuePage,
  setLinearIssuePage,
  setLinearProjectIssueLoadingTargetPage,
  setLinearCustomViewIssueLoadingTargetPage,
  setLinearIssueLoadingTargetPage,
  setLinearProjectIssueLimit,
  setLinearCustomViewIssueLimit,
  setLinearIssueLimit,
  activeLinearIssueLimit,
  activeLinearIssueLoadingTargetPage,
  activeLinearIssueHasCollectionError
}: {
  linearMode: LinearMode
  displayedLinearIssues: LinearIssue[]
  appliedLinearSearch: string
  activeLinearIssueContextLabel: string | null
  linearTeamSelection: ReadonlySet<string>
  linearOrderBy: LinearOrderBy
  activeLinearIssueCanRequestMore: boolean
  activeLinearIssuePage: number
  activeLinearIssueError: string | null
  activeLinearIssueLoading: boolean
  activeLinearIssues: LinearIssue[]
  selectedLinearProject: LinearProjectSummary | null
  linearProjectTab: LinearProjectTab
  selectedLinearCustomView: LinearCustomViewSummary | null
  setLinearProjectIssuePage: Dispatch<SetStateAction<number>>
  setLinearCustomViewIssuePage: Dispatch<SetStateAction<number>>
  setLinearIssuePage: Dispatch<SetStateAction<number>>
  setLinearProjectIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  setLinearCustomViewIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  setLinearIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  setLinearProjectIssueLimit: Dispatch<SetStateAction<number>>
  setLinearCustomViewIssueLimit: Dispatch<SetStateAction<number>>
  setLinearIssueLimit: Dispatch<SetStateAction<number>>
  activeLinearIssueLimit: number
  activeLinearIssueLoadingTargetPage: number | null
  activeLinearIssueHasCollectionError: boolean
}) {
  const filteredLinearIssues = useMemo(() => {
    const searchedIssues =
      linearMode === 'in-orca'
        ? filterLinearIssuesBySearchQuery(displayedLinearIssues, appliedLinearSearch)
        : displayedLinearIssues
    // Why: 'in-orca' is scoped by local workspace links, not by team, and it has no "Fetch more" —
    // a team filter would silently drop a linked ticket with no way to recover it.
    if (activeLinearIssueContextLabel || linearMode === 'in-orca') {
      return searchedIssues
    }
    // Why: team options can arrive after issue rows render; treat an empty selection as "all" until reconciliation sets teams.
    if (searchedIssues.length > 0 && linearTeamSelection.size === 0) {
      return searchedIssues
    }
    return searchedIssues.filter((issue) => linearTeamSelection.has(issue.team.id))
  }, [
    activeLinearIssueContextLabel,
    appliedLinearSearch,
    displayedLinearIssues,
    linearMode,
    linearTeamSelection
  ])

  const orderedLinearIssues = useMemo(
    () => [...filteredLinearIssues].sort((a, b) => compareLinearIssues(a, b, linearOrderBy)),
    [filteredLinearIssues, linearOrderBy]
  )
  const loadedLinearIssuePages = Math.max(
    1,
    Math.ceil(orderedLinearIssues.length / LINEAR_ITEM_LIMIT)
  )
  const linearIssueTotalPages =
    orderedLinearIssues.length === 0
      ? 1
      : loadedLinearIssuePages + (activeLinearIssueCanRequestMore ? 1 : 0)
  const visibleLinearIssuePage = Math.min(
    activeLinearIssuePage,
    Math.max(0, loadedLinearIssuePages - 1)
  )
  const pagedLinearIssues = useMemo(() => {
    const start = visibleLinearIssuePage * LINEAR_ITEM_LIMIT
    return orderedLinearIssues.slice(start, start + LINEAR_ITEM_LIMIT)
  }, [orderedLinearIssues, visibleLinearIssuePage])
  const showLinearIssuePagination =
    orderedLinearIssues.length > 0 &&
    !activeLinearIssueError &&
    linearIssueTotalPages > 1 &&
    !(activeLinearIssueLoading && activeLinearIssues.length === 0)

  const setActiveLinearIssuePage = useCallback(
    (page: number) => {
      if (selectedLinearProject && linearProjectTab === 'issues') {
        setLinearProjectIssuePage(page)
      } else if (selectedLinearCustomView?.model === 'issue') {
        setLinearCustomViewIssuePage(page)
      } else {
        setLinearIssuePage(page)
      }
    },
    [
      linearProjectTab,
      selectedLinearCustomView?.model,
      selectedLinearProject,
      setLinearProjectIssuePage,
      setLinearIssuePage,
      setLinearCustomViewIssuePage
    ]
  )

  const setActiveLinearIssueLoadingTargetPage = useCallback(
    (page: number | null) => {
      if (selectedLinearProject && linearProjectTab === 'issues') {
        setLinearProjectIssueLoadingTargetPage(page)
      } else if (selectedLinearCustomView?.model === 'issue') {
        setLinearCustomViewIssueLoadingTargetPage(page)
      } else {
        setLinearIssueLoadingTargetPage(page)
      }
    },
    [
      linearProjectTab,
      selectedLinearCustomView?.model,
      selectedLinearProject,
      setLinearProjectIssueLoadingTargetPage,
      setLinearIssueLoadingTargetPage,
      setLinearCustomViewIssueLoadingTargetPage
    ]
  )

  const ensureActiveLinearIssueLimit = useCallback(
    (targetLimit: number) => {
      const nextLimit = Math.min(clampLinearIssueListLimit(targetLimit), LINEAR_ISSUE_LIST_MAX)
      if (selectedLinearProject && linearProjectTab === 'issues') {
        setLinearProjectIssueLimit((limit) => Math.max(limit, nextLimit))
      } else if (selectedLinearCustomView?.model === 'issue') {
        setLinearCustomViewIssueLimit((limit) => Math.max(limit, nextLimit))
      } else {
        setLinearIssueLimit((limit) => Math.max(limit, nextLimit))
      }
    },
    [
      linearProjectTab,
      selectedLinearCustomView?.model,
      selectedLinearProject,
      setLinearProjectIssueLimit,
      setLinearIssueLimit,
      setLinearCustomViewIssueLimit
    ]
  )

  const handleLinearIssuePageChange = useCallback(
    (page: number) => {
      if (page < loadedLinearIssuePages) {
        setActiveLinearIssuePage(page)
        setActiveLinearIssueLoadingTargetPage(null)
        return
      }

      // Why: Linear reads are cached as an expanded prefix; a page jump expands it and commits once enough rows arrive.
      setActiveLinearIssueLoadingTargetPage(page)
      ensureActiveLinearIssueLimit((page + 1) * LINEAR_ITEM_LIMIT)
    },
    [
      ensureActiveLinearIssueLimit,
      loadedLinearIssuePages,
      setActiveLinearIssueLoadingTargetPage,
      setActiveLinearIssuePage
    ]
  )

  const showLinearEmptyFilteredLoadMore =
    orderedLinearIssues.length === 0 && !activeLinearIssueError && activeLinearIssueCanRequestMore
  const handleLinearEmptyFilteredLoadMore = useCallback(() => {
    setActiveLinearIssueLoadingTargetPage(null)
    ensureActiveLinearIssueLimit(activeLinearIssueLimit + LINEAR_ITEM_LIMIT)
  }, [activeLinearIssueLimit, ensureActiveLinearIssueLimit, setActiveLinearIssueLoadingTargetPage])

  useEffect(() => {
    if (activeLinearIssueLoading || activeLinearIssueLoadingTargetPage === null) {
      return
    }

    const maxLoadedPage = Math.max(0, loadedLinearIssuePages - 1)
    const targetPageLoaded = activeLinearIssueLoadingTargetPage <= maxLoadedPage
    const targetPageCannotLoad =
      !activeLinearIssueCanRequestMore || activeLinearIssueLimit >= LINEAR_ISSUE_LIST_MAX
    if (targetPageLoaded || targetPageCannotLoad) {
      setActiveLinearIssuePage(Math.min(activeLinearIssueLoadingTargetPage, maxLoadedPage))
      setActiveLinearIssueLoadingTargetPage(null)
      return
    }

    // Why: local filtering can leave the next page short, so keep expanding the prefix until the page exists or Linear is exhausted.
    ensureActiveLinearIssueLimit(activeLinearIssueLimit + LINEAR_ITEM_LIMIT)
  }, [
    activeLinearIssueCanRequestMore,
    activeLinearIssueHasCollectionError,
    activeLinearIssueLimit,
    activeLinearIssueLoading,
    activeLinearIssueLoadingTargetPage,
    ensureActiveLinearIssueLimit,
    loadedLinearIssuePages,
    setActiveLinearIssueLoadingTargetPage,
    setActiveLinearIssuePage
  ])

  useEffect(() => {
    if (
      activeLinearIssueLoadingTargetPage !== null ||
      activeLinearIssuePage <= visibleLinearIssuePage
    ) {
      return
    }
    setActiveLinearIssuePage(visibleLinearIssuePage)
  }, [
    activeLinearIssueLoadingTargetPage,
    activeLinearIssuePage,
    setActiveLinearIssuePage,
    visibleLinearIssuePage
  ])

  return {
    filteredLinearIssues,
    orderedLinearIssues,
    loadedLinearIssuePages,
    linearIssueTotalPages,
    visibleLinearIssuePage,
    pagedLinearIssues,
    showLinearIssuePagination,
    setActiveLinearIssuePage,
    setActiveLinearIssueLoadingTargetPage,
    ensureActiveLinearIssueLimit,
    handleLinearIssuePageChange,
    showLinearEmptyFilteredLoadMore,
    handleLinearEmptyFilteredLoadMore
  }
}
