import type { TaskPageProviderMetadataModel } from '../use-task-page-provider-metadata'
import { useEffect } from 'react'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import { mapSettledWithConcurrency } from '../../../../../shared/map-with-concurrency'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import type { GitLabWorkItem, GitLabTodo } from '../../../../../shared/gitlab-types'
import {
  gitLabTaskRepoSelector,
  isGitLabIssueFilter,
  isGitLabMRFilter
} from '../task-page-source-context'

// Leave headroom below the runtime RPC foreground concurrency of eight for sidebar and other callers.
export const GITLAB_TASK_FETCH_CONCURRENCY = 6

type GitLabLoadingInput = Pick<
  TaskPageProviderMetadataModel,
  | 'gitlabTaskRepos'
  | 'gitlabTaskReposKey'
  | 'gitlabPrimaryRepo'
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
    gitlabTaskRepos,
    gitlabTaskReposKey,
    gitlabPrimaryRepo,
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
  // Fetch issues and MRs separately so a failure stays scoped to its tab.
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
    // Leave out projects hosted on GitHub before glab sees them (#15784); read each repo on the host holding its GitLab sign-in.
    const eligibleRepos = gitlabTaskRepos
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
                // Non-GitLab repos in mixed selections return not_found; omit them without a false failure banner.
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
        // Show failures only when no usable rows remain; mixed selections may include non-GitLab repos.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gitlabTaskReposKey covers every gitlabTaskRepos field read above (see selectedReposKey's GitHub-scoped-context note); keying off the array ref would re-run on every parent render.
  }, [
    taskSource,
    gitlabView,
    activeGitlabFilter,
    gitlabRefreshNonce,
    gitlabTaskReposKey,
    setGitlabError,
    setGitlabItems,
    setGitlabLoading
  ])

  // Todos are user-scoped and ignore repo/chip filters, so fetch them independently.
  useEffect(() => {
    if (taskSource !== 'gitlab' || gitlabView !== 'todos') {
      return
    }
    if (!gitlabPrimaryRepo?.path) {
      setGitlabTodos([])
      setGitlabTodosLoading(false)
      return
    }
    let stale = false
    setGitlabTodosLoading(true)
    const selector = gitLabTaskRepoSelector(gitlabPrimaryRepo)
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
    gitlabPrimaryRepo,
    setGitlabTodosLoading,
    setGitlabTodos
  ])
  return model
}
