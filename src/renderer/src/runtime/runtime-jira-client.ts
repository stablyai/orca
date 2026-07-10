import type {
  GlobalSettings,
  JiraComment,
  JiraConnectionStatus,
  JiraCreateField,
  JiraCreateIssueArgs,
  JiraCreateIssueResult,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraProject,
  JiraSiteSelection,
  JiraTransition,
  JiraUser,
  JiraViewer
} from '../../../shared/types'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { isRuntimeProviderSearchQueryWithinLimit } from './runtime-provider-search-bounds'

export type RuntimeJiraSettings =
  | Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
  | TaskSourceContext
  | null
  | undefined

export type JiraConnectResult = { ok: true; viewer: JiraViewer } | { ok: false; error: string }
export type JiraCommentResult = { ok: true; id: string } | { ok: false; error: string }

function isTaskSourceRuntimeSettings(settings: RuntimeJiraSettings): settings is TaskSourceContext {
  return settings !== null && settings !== undefined && 'kind' in settings
}

function getJiraRuntimeTarget(
  settings: RuntimeJiraSettings
): ReturnType<typeof getActiveRuntimeTarget> {
  // Why: task source context makes provider ownership explicit; legacy callers
  // still pass focused runtime settings until Tasks finishes migrating.
  return getActiveRuntimeTarget(
    isTaskSourceRuntimeSettings(settings) ? getTaskSourceRuntimeSettings(settings) : settings
  )
}

export async function jiraStatus(settings: RuntimeJiraSettings): Promise<JiraConnectionStatus> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectionStatus>(target, 'jira.status', undefined, { timeoutMs: 15_000 })
    : window.api.jira.status()
}

export async function jiraConnect(
  settings: RuntimeJiraSettings,
  args: { siteUrl: string; email: string; apiToken: string }
): Promise<JiraConnectResult> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectResult>(target, 'jira.connect', args, { timeoutMs: 30_000 })
    : window.api.jira.connect(args)
}

export async function jiraDisconnect(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<void> {
  const target = getJiraRuntimeTarget(settings)
  if (target.kind === 'environment') {
    await callRuntimeRpc<{ ok: true }>(target, 'jira.disconnect', siteId ? { siteId } : undefined, {
      timeoutMs: 15_000
    })
    return
  }
  await window.api.jira.disconnect(siteId ? { siteId } : undefined)
}

export async function jiraSelectSite(
  settings: RuntimeJiraSettings,
  siteId: JiraSiteSelection
): Promise<JiraConnectionStatus> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectionStatus>(
        target,
        'jira.selectSite',
        { siteId },
        { timeoutMs: 15_000 }
      )
    : window.api.jira.selectSite({ siteId })
}

export async function jiraTestConnection(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<JiraConnectResult> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectResult>(
        target,
        'jira.testConnection',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.jira.testConnection(siteId ? { siteId } : undefined)
}

export async function jiraSearchIssues(
  settings: RuntimeJiraSettings,
  jql: string,
  limit?: number,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(jql)) {
    return []
  }
  const target = getJiraRuntimeTarget(settings)
  const args = { jql, limit, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraIssue[]>(target, 'jira.searchIssues', args, { timeoutMs: 30_000 })
    : window.api.jira.searchIssues(args)
}

export async function jiraListIssues(
  settings: RuntimeJiraSettings,
  filter?: JiraIssueFilter,
  limit?: number,
  siteId?: JiraSiteSelection | null
): Promise<JiraIssue[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { filter, limit, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraIssue[]>(target, 'jira.listIssues', args, { timeoutMs: 30_000 })
    : window.api.jira.listIssues(args)
}

export async function jiraGetIssue(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraIssue | null> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraIssue | null>(target, 'jira.getIssue', args, { timeoutMs: 30_000 })
    : window.api.jira.getIssue(args)
}

export async function jiraCreateIssue(
  settings: RuntimeJiraSettings,
  args: JiraCreateIssueArgs
): Promise<JiraCreateIssueResult> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCreateIssueResult>(target, 'jira.createIssue', args, { timeoutMs: 30_000 })
    : window.api.jira.createIssue(args)
}

export async function jiraUpdateIssue(
  settings: RuntimeJiraSettings,
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, updates, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraMutationResult>(target, 'jira.updateIssue', args, { timeoutMs: 30_000 })
    : window.api.jira.updateIssue(args)
}

export async function jiraAddIssueComment(
  settings: RuntimeJiraSettings,
  key: string,
  body: string,
  siteId?: string | null
): Promise<JiraCommentResult> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, body, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCommentResult>(target, 'jira.addIssueComment', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.addIssueComment(args)
}

export async function jiraIssueComments(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraComment[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraComment[]>(target, 'jira.issueComments', args, { timeoutMs: 30_000 })
    : window.api.jira.issueComments(args)
}

export async function jiraListProjects(
  settings: RuntimeJiraSettings,
  siteId?: JiraSiteSelection | null
): Promise<JiraProject[]> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraProject[]>(target, 'jira.listProjects', siteId ? { siteId } : undefined, {
        timeoutMs: 30_000
      })
    : window.api.jira.listProjects(siteId ? { siteId } : undefined)
}

export async function jiraListIssueTypes(
  settings: RuntimeJiraSettings,
  projectIdOrKey: string,
  siteId?: string | null
): Promise<JiraIssueType[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { projectIdOrKey, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraIssueType[]>(target, 'jira.listIssueTypes', args, { timeoutMs: 30_000 })
    : window.api.jira.listIssueTypes(args)
}

export async function jiraListCreateFields(
  settings: RuntimeJiraSettings,
  projectIdOrKey: string,
  issueTypeId: string,
  siteId?: string | null
): Promise<JiraCreateField[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { projectIdOrKey, issueTypeId, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraCreateField[]>(target, 'jira.listCreateFields', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.listCreateFields(args)
}

export async function jiraListPriorities(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<JiraPriority[]> {
  const target = getJiraRuntimeTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraPriority[]>(
        target,
        'jira.listPriorities',
        siteId ? { siteId } : undefined,
        { timeoutMs: 30_000 }
      )
    : window.api.jira.listPriorities(siteId ? { siteId } : undefined)
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

export async function jiraListTransitions(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraTransition[]> {
  const target = getJiraRuntimeTarget(settings)
  const args = { key, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraTransition[]>(target, 'jira.listTransitions', args, { timeoutMs: 30_000 })
    : window.api.jira.listTransitions(args)
}
