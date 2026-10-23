import type { TaskPageProviderMetadataModel } from '../../use-task-page-provider-metadata'
import { useEffect } from 'react'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import { mapSettledWithConcurrency } from '../../../../../shared/map-with-concurrency'
import type { Repo } from '../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { GitLabDialogRepoSelector } from '../../gitlab-item-dialog/gitlab-item-dialog-types'
import type { GitLabWorkItem, GitLabTodo } from '../../../../../shared/gitlab-types'
import {
  getTaskPageRepoSourceContext,
  isGitLabIssueFilter,
  isGitLabMRFilter
} from '../../task-page-source-context'

// Why: "All projects" fans out one list call per repo; staying below the runtime RPC queue's
// foreground concurrency (8) leaves headroom for other callers on the same selector, such as the sidebar.
export const GITLAB_TASK_FETCH_CONCURRENCY = 6

function gitLabTaskRepoSelector(repo: Repo): GitLabDialogRepoSelector {
  return {
    repoPath: repo.path,
    repoId: repo.id,
    sourceContext: getTaskPageRepoSourceContext(repo, 'gitlab'),
    repoOwnerExecutionHostId: getRepoExecutionHostId(repo)
  }
}

type GitLabLoadingInput = Pick<
  TaskPageProviderMetadataModel,
  | 'selectedRepos'
  | 'selectedReposKey'
  | 'primaryRepo'
  | 'taskSource'
  | 'setGitlabItems'
  | 'setGitlabLoading'
  | 'setGitlabError'
  | 'gitlabRefreshNonce'
  | 'gitlabView'
  | 'setGitlabTodos'
  | 'setGitlabTodosLoading'
  | 'activeGitlabFilter'
>

export function useTaskPageGitLabLoading<Model extends GitLabLoadingInput>(model: Model): Model {
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
    // Why: folder-mode repos lack remotes to derive a GitLab project from; each repo is read on the machine holding its GitLab sign-in.
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
            const selector = gitLabTaskRepoSelector(repo)
            return gitLabApiFor(selector)
              .listIssues({
                ...selector,
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
                  repo,
                  items: typed.items,
                  error
                }
              })
          }
        : (repo: (typeof eligibleRepos)[0]) => {
            const selector = gitLabTaskRepoSelector(repo)
            return gitLabApiFor(selector)
              .listMRs({
                ...selector,
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
                  repo,
                  items: typed.items,
                  error
                }
              })
          }
    void mapSettledWithConcurrency(eligibleRepos, GITLAB_TASK_FETCH_CONCURRENCY, (repo) =>
      // Why: a stale selection's results are discarded below, so skip the repos not yet started.
      stale ? Promise.resolve({ repo, items: [], error: undefined }) : fetchItems(repo)
    )
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
          // Why the host: a twin's two rows share the id, so only the stamp names the row that answered.
          const repoHostId = getRepoExecutionHostId(r.value.repo)
          for (const item of r.value.items) {
            merged.push({
              ...item,
              repoId: r.value.repo.id,
              repoHostId
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
    const selector = gitLabTaskRepoSelector(primaryRepo)
    void gitLabApiFor(selector)
      .todos(selector)
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
