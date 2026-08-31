import { useEffect, type Dispatch, type SetStateAction } from 'react'

import {
  isGitLabIssueFilter,
  isGitLabMRFilter
} from '@/components/task-page/gitlab/gitlab-task-filters'
import { resolveGitLabIssuePageState } from '@/components/task-page/gitlab/gitlab-issue-pages'
import { getTaskPageRepoSourceContext } from '@/components/task-page/source/repo-source-context'
import { withGitLabIpcTimeout } from '@/runtime/gitlab-ipc-timeout'
import type { GitLabIssueFilter, GitLabTaskFilter } from '@/components/task-page-localized-options'
import type { GitLabTodo, GitLabWorkItem } from '../../../../../shared/gitlab-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { TaskProvider } from '../../../../../shared/task-providers'

const GITLAB_ISSUE_PAGE_SIZE = 50

export function useTaskPageGitLabFetch({
  taskSource,
  gitlabView,
  activeGitlabFilter,
  gitlabRefreshNonce,
  selectedRepos,
  selectedReposKey,
  primaryRepo,
  gitlabIssuePage,
  setGitlabItems,
  setGitlabLoading,
  setGitlabError,
  setGitlabIssuePage,
  setGitlabIssueTotalPages,
  setGitlabIssueLoadingTargetPage,
  setGitlabTodos,
  setGitlabTodosLoading
}: {
  taskSource: TaskProvider
  gitlabView: 'issues' | 'mrs' | 'todos'
  activeGitlabFilter: GitLabTaskFilter | GitLabIssueFilter
  gitlabRefreshNonce: number
  selectedRepos: readonly Repo[]
  selectedReposKey: string
  primaryRepo: Repo | null
  gitlabIssuePage: number
  setGitlabItems: Dispatch<SetStateAction<GitLabWorkItem[]>>
  setGitlabLoading: Dispatch<SetStateAction<boolean>>
  setGitlabError: Dispatch<SetStateAction<string | null>>
  setGitlabIssuePage: Dispatch<SetStateAction<number>>
  setGitlabIssueTotalPages: Dispatch<SetStateAction<number>>
  setGitlabIssueLoadingTargetPage: Dispatch<SetStateAction<number | null>>
  setGitlabTodos: Dispatch<SetStateAction<GitLabTodo[]>>
  setGitlabTodosLoading: Dispatch<SetStateAction<boolean>>
}): void {
  // Why: fetch GitLab Issues and MRs separately so errors stay isolated per tab (mirrors GitHub's split endpoints).
  useEffect(() => {
    if (taskSource !== 'gitlab') {
      return
    }
    if (gitlabView === 'todos') {
      return
    }
    const activeIssueFilter =
      gitlabView === 'issues' && isGitLabIssueFilter(activeGitlabFilter) ? activeGitlabFilter : null
    const activeMRFilter =
      gitlabView === 'mrs' && isGitLabMRFilter(activeGitlabFilter) ? activeGitlabFilter : null
    if (
      (gitlabView === 'issues' && !activeIssueFilter) ||
      (gitlabView === 'mrs' && !activeMRFilter)
    ) {
      return
    }
    // Why: folder-mode repos lack remotes to derive a GitLab project from; SSH-backed repos use the same provider-aware IPC path.
    const eligibleRepos = selectedRepos
    if (eligibleRepos.length === 0) {
      setGitlabItems([])
      setGitlabLoading(false)
      setGitlabError(null)
      return
    }
    let stale = false
    // Why: a retreat re-runs this effect immediately; clearing loading in between would flash the
    // spinner off and re-enable the pager buttons over rows that are about to be replaced.
    let retreating = false
    setGitlabLoading(true)
    setGitlabError(null)

    const fetchItems =
      gitlabView === 'issues'
        ? (repo: (typeof eligibleRepos)[0]) => {
            const isAssignedToMe = activeIssueFilter === 'assigned-to-me'
            return withGitLabIpcTimeout(
              window.api.gl.listIssues({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext: getTaskPageRepoSourceContext(repo, 'gitlab'),
                state: 'opened',
                assignee: isAssignedToMe ? '@me' : undefined,
                limit: GITLAB_ISSUE_PAGE_SIZE,
                page: gitlabIssuePage + 1
              })
            ).then((result) => {
              const typed = result as {
                items: GitLabWorkItem[]
                totalPages?: number
                error?: { type?: string; message: string }
              }
              // Why: not_found just means the repo isn't a GitLab project (mixed selection); drop it so the list shows no false errors.
              const error = typed.error?.type === 'not_found' ? undefined : typed.error
              return { repoId: repo.id, items: typed.items, totalPages: typed.totalPages, error }
            })
          }
        : (repo: (typeof eligibleRepos)[0]) =>
            withGitLabIpcTimeout(
              window.api.gl.listMRs({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext: getTaskPageRepoSourceContext(repo, 'gitlab'),
                state: activeMRFilter ?? 'opened',
                page: 1,
                perPage: 50
              })
            ).then((result) => {
              const typed = result as {
                items: GitLabWorkItem[]
                error?: { type?: string; message: string }
              }
              const error = typed.error?.type === 'not_found' ? undefined : typed.error
              return { repoId: repo.id, items: typed.items, error }
            })

    void Promise.allSettled(eligibleRepos.map(fetchItems))
      .then((results) => {
        if (stale) {
          return
        }
        const merged: GitLabWorkItem[] = []
        const errs: string[] = []
        const settled: { items: readonly GitLabWorkItem[]; totalPages?: number }[] = []
        for (const r of results) {
          if (r.status !== 'fulfilled') {
            errs.push(r.reason instanceof Error ? r.reason.message : String(r.reason))
            continue
          }
          settled.push(r.value)
          for (const item of r.value.items) {
            merged.push({ ...item, repoId: r.value.repoId })
          }
          if (r.value.error) {
            errs.push(r.value.error.message)
          }
        }
        if (gitlabView === 'issues') {
          const pager = resolveGitLabIssuePageState({
            requestedPage: gitlabIssuePage,
            errorCount: errs.length,
            results: settled
          })
          if (pager.totalPages !== null) {
            setGitlabIssueTotalPages(pager.totalPages)
          }
          // Why: an overshot page holds nothing worth showing — step back and let the refetch fill the list.
          if (pager.page !== gitlabIssuePage) {
            retreating = true
            setGitlabIssuePage(pager.page)
            return
          }
        }
        merged.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        setGitlabItems(merged)
        // Why: only banner when every eligible repo failed; a partial one would hide working rows in a mixed (non-GitLab) selection.
        if (errs.length > 0 && merged.length === 0) {
          setGitlabError(errs[0])
        }
      })
      .finally(() => {
        if (!stale && !retreating) {
          setGitlabLoading(false)
          setGitlabIssueLoadingTargetPage(null)
        }
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedReposKey covers every selectedRepos field read above (see its GitHub-scoped-context note); keying off the array ref would re-run on every parent render.
  }, [
    taskSource,
    gitlabView,
    activeGitlabFilter,
    gitlabRefreshNonce,
    selectedReposKey,
    gitlabIssuePage
  ])

  // Why: Todos fetch has its own effect — different trigger (no chip filter) and data path (gl.todos is user-scoped, not repo-scoped).
  useEffect(() => {
    if (taskSource !== 'gitlab' || gitlabView !== 'todos') {
      return
    }
    if (!primaryRepo?.path) {
      setGitlabTodos([])
      setGitlabTodosLoading(false)
      return
    }
    let stale = false
    setGitlabTodosLoading(true)
    void withGitLabIpcTimeout(
      window.api.gl.todos({
        repoPath: primaryRepo.path,
        repoId: primaryRepo.id,
        sourceContext: getTaskPageRepoSourceContext(primaryRepo, 'gitlab')
      })
    )
      .then((todos) => {
        if (!stale) {
          setGitlabTodos(todos as GitLabTodo[])
        }
      })
      .catch(() => {
        if (!stale) {
          setGitlabTodos([])
        }
      })
      .finally(() => {
        if (!stale) {
          setGitlabTodosLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the remaining referenced setters and refs are stable useState/useRef identities passed in as props.
  }, [taskSource, gitlabView, gitlabRefreshNonce, primaryRepo])
}
