import { useMemo, useState } from 'react'

import { getRepoBackedTaskEmptyState } from '@/components/task-page-empty-state'
import {
  isGitLabIssueFilter,
  isGitLabMRFilter
} from '@/components/task-page/gitlab/gitlab-task-filters'
import type { GitLabIssueFilter, GitLabTaskFilter } from '@/components/task-page-localized-options'
import type { GitLabTodo, GitLabWorkItem } from '../../../../../shared/gitlab-types'

export function useTaskPageGitLabListState({
  selectedRepos
}: {
  selectedRepos: { length: number }
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
