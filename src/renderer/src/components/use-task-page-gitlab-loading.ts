import type { TaskPageProviderMetadataModel } from './use-task-page-provider-metadata'
import { useEffect } from 'react'
import type { GitLabWorkItem, GitLabTodo } from '../../../shared/gitlab-types'
import {
  getTaskPageRepoSourceContext,
  isGitLabIssueFilter,
  isGitLabMRFilter
} from './task-page-source-context'
export function useTaskPageGitLabLoading(model: TaskPageProviderMetadataModel) {
  const {
    selectedRepos,
    selectedReposKey,
    primaryRepo,
    taskSource,
    setGitlabItems,
    setGitlabLoading,
    setGitlabError,
    gitlabRefreshNonce,
    gitlabView,
    setGitlabTodos,
    setGitlabTodosLoading,
    activeGitlabFilter
  } = model
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
    setGitlabLoading(true)
    setGitlabError(null)
    const fetchItems =
      gitlabView === 'issues'
        ? (repo: (typeof eligibleRepos)[0]) => {
            const isAssignedToMe = activeIssueFilter === 'assigned-to-me'
            return window.api.gl
              .listIssues({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext: getTaskPageRepoSourceContext(repo, 'gitlab'),
                state: 'opened',
                assignee: isAssignedToMe ? '@me' : undefined,
                limit: 50
              })
              .then((result) => {
                const typed = result as {
                  items: GitLabWorkItem[]
                  error?: {
                    type?: string
                    message: string
                  }
                }
                // Why: not_found just means the repo isn't a GitLab project (mixed selection); drop it so the list shows no false errors.
                const error = typed.error?.type === 'not_found' ? undefined : typed.error
                return {
                  repoId: repo.id,
                  items: typed.items,
                  error
                }
              })
          }
        : (repo: (typeof eligibleRepos)[0]) =>
            window.api.gl
              .listMRs({
                repoPath: repo.path,
                repoId: repo.id,
                sourceContext: getTaskPageRepoSourceContext(repo, 'gitlab'),
                state: activeMRFilter ?? 'opened',
                page: 1,
                perPage: 50
              })
              .then((result) => {
                const typed = result as {
                  items: GitLabWorkItem[]
                  error?: {
                    type?: string
                    message: string
                  }
                }
                const error = typed.error?.type === 'not_found' ? undefined : typed.error
                return {
                  repoId: repo.id,
                  items: typed.items,
                  error
                }
              })
    void Promise.allSettled(eligibleRepos.map(fetchItems))
      .then((results) => {
        if (stale) {
          return
        }
        const merged: GitLabWorkItem[] = []
        const errs: string[] = []
        for (const r of results) {
          if (r.status !== 'fulfilled') {
            errs.push(r.reason instanceof Error ? r.reason.message : String(r.reason))
            continue
          }
          for (const item of r.value.items) {
            merged.push({
              ...item,
              repoId: r.value.repoId
            })
          }
          if (r.value.error) {
            errs.push(r.value.error.message)
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
        if (!stale) {
          setGitlabLoading(false)
        }
      })
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- selectedReposKey covers every selectedRepos field read above (see its GitHub-scoped-context note); keying off the array ref would re-run on every parent render.
  }, [taskSource, gitlabView, activeGitlabFilter, gitlabRefreshNonce, selectedReposKey])

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
    void window.api.gl
      .todos({
        repoPath: primaryRepo.path,
        repoId: primaryRepo.id,
        sourceContext: getTaskPageRepoSourceContext(primaryRepo, 'gitlab')
      })
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
  }, [
    taskSource,
    gitlabView,
    gitlabRefreshNonce,
    primaryRepo,
    setGitlabTodosLoading,
    setGitlabTodos
  ])
  return model
}
export type TaskPageGitLabLoadingModel = ReturnType<typeof useTaskPageGitLabLoading>
