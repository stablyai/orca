import type { TaskPageSourceAvailabilityPreludeModel } from './use-task-page-source-availability'
import { useMemo } from 'react'
import { buildSelectedReposKey } from '@/components/task-page-work-item-pagination'
import { getTaskPageRepoSourceContext } from './task-page-source-context'
import { buildTaskPageSourceRepoScope } from './task-page-source-repo-scope'
import { useTaskPageGitLabKnownHosts } from './use-task-page-gitlab-known-hosts'

// Why: the project selection is shared by every source, so each repo-backed source
// narrows it to the repos its forge can answer for before anything is queried (#15784).
export function useTaskPageSourceRepoScope(model: TaskPageSourceAvailabilityPreludeModel) {
  const { selectedRepos, taskSource } = model
  const gitlabKnownHostsFor = useTaskPageGitLabKnownHosts(selectedRepos, taskSource === 'github')
  const githubScope = useMemo(
    () => buildTaskPageSourceRepoScope(selectedRepos, 'github', gitlabKnownHostsFor),
    [selectedRepos, gitlabKnownHostsFor]
  )
  const gitlabScope = useMemo(
    () => buildTaskPageSourceRepoScope(selectedRepos, 'gitlab', gitlabKnownHostsFor),
    [selectedRepos, gitlabKnownHostsFor]
  )
  const githubTaskRepos = githubScope.repos
  const githubExcludedRepos = githubScope.excludedRepos
  const githubTaskReposPending = githubScope.pending
  // Why: same shape as selectedReposKey, so GitHub effects refire only when the queried set changes.
  const githubTaskReposKey = useMemo(
    () => buildSelectedReposKey(githubTaskRepos, (r) => getTaskPageRepoSourceContext(r, 'github')),
    [githubTaskRepos]
  )
  const gitlabTaskRepos = gitlabScope.repos
  const gitlabExcludedRepos = gitlabScope.excludedRepos
  // Why: see selectedReposKey — provider-independent fields are what the GitLab requests read.
  const gitlabTaskReposKey = useMemo(
    () => buildSelectedReposKey(gitlabTaskRepos, (r) => getTaskPageRepoSourceContext(r, 'github')),
    [gitlabTaskRepos]
  )
  // Why: Todos are user-scoped, so any queried GitLab repo names the account to read them from.
  const gitlabPrimaryRepo = gitlabTaskRepos[0] ?? null
  return Object.assign(model, {
    githubTaskRepos,
    githubExcludedRepos,
    githubTaskReposPending,
    githubTaskReposKey,
    gitlabTaskRepos,
    gitlabExcludedRepos,
    gitlabTaskReposKey,
    gitlabPrimaryRepo
  })
}
export type TaskPageSourceRepoScopeModel = ReturnType<typeof useTaskPageSourceRepoScope>
