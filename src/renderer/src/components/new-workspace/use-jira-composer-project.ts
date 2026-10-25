import { useState } from 'react'
import type { JiraProjectReference } from '../../../../shared/jira/jira-project-reference'
import type { Repo } from '../../../../shared/repo-types'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { resolveJiraSourceHostId } from '../../../../shared/jira/jira-source-host'
import { useJiraProjectInventory } from '../use-jira-project-inventory'

const LOCAL_SOURCE = { kind: 'local' } as const

export function useJiraComposerProject(
  repo: Repo | null,
  source: TaskSourceContext | null,
  enabled: boolean
) {
  const inventory = useJiraProjectInventory(source ?? LOCAL_SOURCE, enabled && source !== null)
  const scopeKey = JSON.stringify([
    repo ? getRepoExecutionHostId(repo) : null,
    repo?.id ?? null,
    repo?.path ?? null,
    source?.hostId ?? null,
    source?.projectId ?? null,
    source?.projectHostSetupId ?? null
  ])
  const [override, setOverride] = useState<{
    scopeKey: string
    project: JiraProjectReference | null
  } | null>(null)
  const project =
    override?.scopeKey === scopeKey
      ? override.project
      : repo &&
          resolveJiraSourceHostId({ workspaceHostId: getRepoExecutionHostId(repo) }) ===
            source?.hostId
        ? (repo.defaultJiraProject ?? null)
        : null
  return {
    jiraProject: project,
    jiraProjectInventory: inventory,
    setJiraProject: (next: JiraProjectReference | null) => setOverride({ scopeKey, project: next })
  }
}
