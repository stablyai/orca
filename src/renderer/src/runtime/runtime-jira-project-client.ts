import type {
  JiraConnectionStatus,
  JiraProject,
  JiraSiteSelection
} from '../../../shared/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'
import { parseJiraConnectionStatus } from './runtime-jira-connection-status'

export async function jiraStatusForTarget(
  target: RuntimeClientTarget
): Promise<JiraConnectionStatus> {
  return parseJiraConnectionStatus(
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(target, 'jira.status', undefined, { timeoutMs: 15_000 })
      : await window.api.jira.status()
  )
}

export async function jiraListProjectsForTarget(
  target: RuntimeClientTarget,
  siteId?: JiraSiteSelection | null
): Promise<JiraProject[]> {
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraProject[]>(target, 'jira.listProjects', siteId ? { siteId } : undefined, {
        timeoutMs: 30_000
      })
    : window.api.jira.listProjects(siteId ? { siteId } : undefined)
}
