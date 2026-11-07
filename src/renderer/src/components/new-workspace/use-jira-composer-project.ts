import type { JiraProjectReference } from '../../../../shared/jira/jira-project-reference'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { resolveJiraSourceHostId } from '../../../../shared/jira/jira-source-host'
import { useJiraProjectInventory } from '../use-jira-project-inventory'
import { useComposerSourceScope } from './use-composer-source-scope'

const LOCAL_SOURCE = { kind: 'local' } as const

export function useJiraComposerProject(
  repo: Repo | null,
  source: TaskSourceContext | null,
  enabled: boolean
) {
  const inventory = useJiraProjectInventory(source ?? LOCAL_SOURCE, enabled && source !== null)
  const defaultProject =
    repo &&
    resolveJiraSourceHostId({ workspaceHostId: getRepoExecutionHostId(repo) }) === source?.hostId
      ? (repo.defaultJiraProject ?? null)
      : null
  const [project, setProject] = useComposerSourceScope<JiraProjectReference | null>(
    repo,
    source,
    defaultProject
  )
  return {
    jiraProject: project,
    jiraProjectInventory: inventory,
    setJiraProject: setProject
  }
}
