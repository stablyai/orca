import { useMemo, useState } from 'react'

import { getRepoBackedTaskEmptyState } from '@/components/task-page-empty-state'
import {
  isGitLabIssueFilter,
  isGitLabMRFilter
} from '@/components/task-page/gitlab/gitlab-task-filters'
import type { GitLabIssueFilter, GitLabTaskFilter } from '@/components/task-page-localized-options'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { GitLabTodo, GitLabWorkItem } from '../../../../../shared/gitlab-types'

export function useTaskPageGitLabListState({
  taskSource,
  selectedRepos,
  selectedReposKey
}: {
  taskSource: TaskProvider
  selectedRepos: { length: number }
  selectedReposKey: string
}) {
  // ── GitLab task-source state ──────────────────────────────────────
  // Why: parallel to Linear's slim per-source state — skips workItemsCache and cross-repo aggregation; fetches directly via window.api.gl for the primary repo.
  const [gitlabFilter, setGitlabFilter] = useState<GitLabTaskFilter | GitLabIssueFilter>('opened')
  const [gitlabItems, setGitlabItems] = useState<GitLabWorkItem[]>([])
  const [gitlabLoading, setGitlabLoading] = useState(false)
  const [gitlabError, setGitlabError] = useState<string | null>(null)
  const [gitlabRefreshNonce, setGitlabRefreshNonce] = useState(0)
  // Why: separate from gitlabItems so the dialog target survives a list refresh that removes the item from the visible filter (e.g. closing an MR).
  const [gitlabDialogItem, setGitlabDialogItem] = useState<GitLabWorkItem | null>(null)

  // Why: Issues paginate (#13357) — 0-based here, mapped onto GitLab's 1-based page at fetch time.
  const [gitlabIssuePage, setGitlabIssuePage] = useState(0)
  const [gitlabIssueTotalPages, setGitlabIssueTotalPages] = useState(1)
  const [gitlabIssueLoadingTargetPage, setGitlabIssueLoadingTargetPage] = useState<number | null>(
    null
  )

  // Why: GitLab tab has two sub-views — the project MR/issue list and the user's cross-project Todos (a separate stream).
  const [gitlabView, setGitlabView] = useState<'issues' | 'mrs' | 'todos'>('mrs')
  const [gitlabTodos, setGitlabTodos] = useState<GitLabTodo[]>([])
  const [gitlabTodosLoading, setGitlabTodosLoading] = useState(false)
  const gitlabEmptyState = useMemo(
    () =>
      getRepoBackedTaskEmptyState({
        provider: 'gitlab',
        selectedRepoCount: selectedRepos.length,
        gitlabView
      }),
    [gitlabView, selectedRepos.length]
  )

  const gitlabFilterIsValid =
    gitlabView === 'issues'
      ? isGitLabIssueFilter(gitlabFilter)
      : gitlabView === 'mrs'
        ? isGitLabMRFilter(gitlabFilter)
        : true
  const activeGitlabFilter = gitlabFilterIsValid ? gitlabFilter : 'opened'
  // Why: Issues and MRs expose different filter sets; repair before commit so fetch effects never run glab with a stale filter from the other view.
  if (!gitlabFilterIsValid) {
    setGitlabFilter('opened')
  }

  // Why: reset the pager before commit, not in an effect, so the fetch effect sees page 0 in the
  // same render — an effect would fire one throwaway request for the previous chip's deep page.
  const gitlabIssueContextKey = `${taskSource}|${gitlabView}|${activeGitlabFilter}|${selectedReposKey}|${gitlabRefreshNonce}`
  const [lastGitlabIssueContextKey, setLastGitlabIssueContextKey] = useState(gitlabIssueContextKey)
  if (lastGitlabIssueContextKey !== gitlabIssueContextKey) {
    setLastGitlabIssueContextKey(gitlabIssueContextKey)
    setGitlabIssuePage(0)
    setGitlabIssueTotalPages(1)
    setGitlabIssueLoadingTargetPage(null)
  }

  const displayedGitLabItems = useMemo(() => {
    if (gitlabView === 'issues') {
      return gitlabItems.filter((item) => item.type === 'issue')
    }
    if (gitlabView === 'mrs') {
      return gitlabItems.filter((item) => item.type === 'mr')
    }
    return gitlabItems
  }, [gitlabItems, gitlabView])

  return {
    gitlabFilter,
    setGitlabFilter,
    gitlabItems,
    setGitlabItems,
    gitlabLoading,
    setGitlabLoading,
    gitlabError,
    setGitlabError,
    gitlabRefreshNonce,
    setGitlabRefreshNonce,
    gitlabDialogItem,
    setGitlabDialogItem,
    gitlabView,
    setGitlabView,
    gitlabIssuePage,
    setGitlabIssuePage,
    gitlabIssueTotalPages,
    setGitlabIssueTotalPages,
    gitlabIssueLoadingTargetPage,
    setGitlabIssueLoadingTargetPage,
    gitlabTodos,
    setGitlabTodos,
    gitlabTodosLoading,
    setGitlabTodosLoading,
    gitlabEmptyState,
    gitlabFilterIsValid,
    activeGitlabFilter,
    displayedGitLabItems
  }
}
