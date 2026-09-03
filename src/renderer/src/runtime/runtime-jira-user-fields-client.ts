import type {
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraUser
} from '../../../shared/jira-types'
import {
  JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
  JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE
} from '../../../shared/protocol-version'
import {
  assertRuntimeEnvironmentCapability,
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-client'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

export async function jiraCreateIssue(
  settings: RuntimeJiraSettings,
  args: JiraCreateIssueArgs
): Promise<JiraCreateIssueResult> {
  const target = getJiraRuntimeTarget(settings)
  if (target.kind === 'environment' && (args.userFieldKeys?.length ?? 0) > 0) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
      JIRA_USER_FIELDS_UPDATE_REQUIRED_MESSAGE,
      30_000
    )
  }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCreateIssueResult>(target, 'jira.createIssue', args, { timeoutMs: 30_000 })
    : window.api.jira.createIssue(args)
}

export async function jiraListAssignableUsers(
  settings: RuntimeJiraSettings,
  key: string,
  query?: string,
  siteId?: string | null
): Promise<JiraUser[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getJiraRuntimeTarget(settings)
  const args = { key, query, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraUser[]>(target, 'jira.listAssignableUsers', args, { timeoutMs: 30_000 })
    : window.api.jira.listAssignableUsers(args)
}

export async function jiraSearchUsers(
  settings: RuntimeJiraSettings,
  query?: string,
  siteId?: string | null
): Promise<JiraUser[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(query)) {
    return []
  }
  const target = getJiraRuntimeTarget(settings)
  if (
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      JIRA_USER_FIELDS_RUNTIME_CAPABILITY,
      30_000
    ))
  ) {
    return []
  }
  const args = { query, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraUser[]>(target, 'jira.searchUsers', args, { timeoutMs: 30_000 })
    : window.api.jira.searchUsers(args)
}
