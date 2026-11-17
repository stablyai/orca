import { useCallback, useState } from 'react'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  matchesJiraProject,
  type JiraProjectReference
} from '../../../../../../shared/jira/jira-project-reference'
import type { JiraProject } from '../../../../../../shared/jira/jira-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { resolveJiraSourceHostId } from '../../../../../../shared/jira/jira-source-host'
import { getRepoHostIdentity } from '../../../../../../shared/repository/repo-host-identity'

// The default is kept with the pick so a later repo default change in Settings wins again.
type JiraProjectOverride = {
  project: JiraProjectReference | null
  defaultProject: JiraProjectReference | null
}

// Session memory: picks survive leaving the Tasks view but not an app restart.
const jiraProjectOverrides = new Map<string, JiraProjectOverride>()

export function useTaskPageJiraProjectScope(
  repos: readonly Repo[],
  selectedRepos: readonly Repo[],
  preselectedRepoId: string | undefined,
  hostId: ExecutionHostId,
  siteId: string | null | undefined,
  projects: readonly JiraProject[],
  projectsLoading: boolean
) {
  const preselectedRepos = preselectedRepoId
    ? repos.filter((entry) => entry.id === preselectedRepoId)
    : []
  const selectedRepo = selectedRepos.length === 1 ? selectedRepos[0] : null
  const preselectedRepo = preselectedRepos.length === 1 ? preselectedRepos[0] : null
  const repo =
    !preselectedRepoId || selectedRepo?.id === preselectedRepoId
      ? selectedRepo
      : preselectedRepos.length > 1
        ? null
        : preselectedRepo &&
            resolveJiraSourceHostId({
              workspaceHostId: getRepoExecutionHostId(preselectedRepo)
            }) === hostId
          ? preselectedRepo
          : selectedRepo
  const scopeKey = JSON.stringify([hostId, repo ? getRepoHostIdentity(repo) : null, siteId ?? null])
  const [overrides, setOverrides] = useState<ReadonlyMap<string, JiraProjectOverride>>(
    () => new Map(jiraProjectOverrides)
  )
  const override = overrides.get(scopeKey)
  const defaultProject =
    repo && resolveJiraSourceHostId({ workspaceHostId: getRepoExecutionHostId(repo) }) === hostId
      ? (repo.defaultJiraProject ?? null)
      : null
  const scopedDefaultProject =
    defaultProject && (!siteId || siteId === 'all' || defaultProject.siteId === siteId)
      ? defaultProject
      : null
  const pick =
    override &&
    override.defaultProject?.id === scopedDefaultProject?.id &&
    override.defaultProject?.siteId === scopedDefaultProject?.siteId
      ? override.project
      : undefined
  // A failed or pending load leaves the list empty, so only a loaded list can rule a pick out.
  const pickUnavailable =
    pick &&
    !projectsLoading &&
    projects.length > 0 &&
    !projects.some((project) => matchesJiraProject(project, pick))
  const jiraProjectFilter = pick === undefined || pickUnavailable ? scopedDefaultProject : pick
  const setJiraProjectFilter = useCallback(
    (project: JiraProjectReference | null) => {
      jiraProjectOverrides.set(scopeKey, { project, defaultProject: scopedDefaultProject })
      setOverrides(new Map(jiraProjectOverrides))
    },
    [scopeKey, scopedDefaultProject]
  )
  return { jiraProjectFilter, setJiraProjectFilter }
}
