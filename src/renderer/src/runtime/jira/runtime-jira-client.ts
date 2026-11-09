import {
  JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
  JIRA_STATUS_FILTER_UPDATE_REQUIRED
} from '../../../../shared/jira/jira-quick-filters'
import type {
  JiraAuthType,
  JiraComment,
  JiraConnectionStatus,
  JiraCreateField,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueType,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraProject,
  JiraProjectStatusOrder,
  JiraSiteSelection,
  JiraTransition,
  JiraViewer
} from '../../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { searchLocalJiraIssues } from './local-jira-search-cancellation'
import { assertRuntimeEnvironmentCapability } from '../rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { clearJiraImageCache } from './runtime-jira-image-cache'
import { isRuntimeProviderSearchQueryWithinLimit } from '../issue-search/runtime-provider-search-bounds'
import { rowLessSourceTarget } from '../hosts/selection/default-creation-host'
import type { RowLessSource as RuntimeJiraSettings } from '../hosts/selection/default-creation-host'
import { parseJiraConnectionStatus } from './runtime-jira-connection-status'
import { jiraListProjectsForTarget, jiraStatusForTarget } from './runtime-jira-project-client'

import {
  jiraGetIssueForTarget,
  jiraUpdateIssueForTarget,
  jiraAddIssueCommentForTarget,
  jiraIssueCommentsForTarget,
  jiraListPrioritiesForTarget,
  jiraListTransitionsForTarget
} from './runtime-jira-detail-client'

import { JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY } from '../../../../shared/jira/jira-detail-capabilities'

export type JiraConnectResult = { ok: true; viewer: JiraViewer } | { ok: false; error: string }

import type { JiraCommentResult } from './runtime-jira-detail-client'

export async function jiraStatus(settings: RuntimeJiraSettings): Promise<JiraConnectionStatus> {
  return jiraStatusForTarget(rowLessSourceTarget(settings))
}

export async function jiraConnect(
  settings: RuntimeJiraSettings,
  args: { siteUrl: string; email: string; apiToken: string; authType?: JiraAuthType }
): Promise<JiraConnectResult> {
  const target = rowLessSourceTarget(settings)
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraConnectResult>(target, 'jira.connect', args, { timeoutMs: 30_000 })
    : window.api.jira.connect(args)
}

export async function jiraDisconnect(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<void> {
  clearJiraImageCache()
  const target = rowLessSourceTarget(settings)
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
  const target = rowLessSourceTarget(settings)
  return parseJiraConnectionStatus(
    target.kind === 'environment'
      ? await callRuntimeRpc<unknown>(target, 'jira.selectSite', { siteId }, { timeoutMs: 15_000 })
      : await window.api.jira.selectSite({ siteId })
  )
}

export async function jiraTestConnection(
  settings: RuntimeJiraSettings,
  siteId?: string | null
): Promise<JiraConnectResult> {
  const target = rowLessSourceTarget(settings)
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
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal
): Promise<JiraIssue[]> {
  return jiraSearchIssuesForTarget(rowLessSourceTarget(settings), jql, limit, siteId, signal)
}

export async function jiraSearchIssuesForTarget(
  target: RuntimeClientTarget,
  jql: string,
  limit?: number,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal
): Promise<JiraIssue[]> {
  if (!isRuntimeProviderSearchQueryWithinLimit(jql)) {
    return []
  }
  const args = { jql, limit, siteId: siteId ?? undefined }
  if (target.kind === 'environment') {
    return callRuntimeRpc<JiraIssue[]>(target, 'jira.searchIssues', args, {
      timeoutMs: 30_000,
      signal
    })
  }
  return signal ? searchLocalJiraIssues(args, signal) : window.api.jira.searchIssues(args)
}

export async function jiraListIssues(
  settings: RuntimeJiraSettings,
  filter?: JiraIssueFilter,
  limit?: number,
  siteId?: JiraSiteSelection | null,
  filters?: JiraIssueListFilters
): Promise<JiraIssue[]> {
  return jiraListIssuesForTarget(rowLessSourceTarget(settings), filter, limit, siteId, filters)
}

export async function jiraListIssuesForTarget(
  target: RuntimeClientTarget,
  filter?: JiraIssueFilter,
  limit?: number,
  siteId?: JiraSiteSelection | null,
  filters?: JiraIssueListFilters
): Promise<JiraIssue[]> {
  const args = { filter, limit, siteId: siteId ?? undefined, ...(filters ? { filters } : {}) }
  if (target.kind === 'environment') {
    if (filters?.currentSprint) {
      await assertRuntimeEnvironmentCapability(
        target.environmentId,
        JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY,
        'Update the remote Orca server to filter preset issues by current sprint.'
      )
    }
    if (filters?.statuses?.length) {
      await assertRuntimeEnvironmentCapability(
        target.environmentId,
        JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
        JIRA_STATUS_FILTER_UPDATE_REQUIRED,
        15_000
      )
    }
    return callRuntimeRpc<JiraIssue[]>(target, 'jira.listIssues', args, { timeoutMs: 30_000 })
  }
  return window.api.jira.listIssues(args)
}

export async function jiraGetIssue(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraIssue | null> {
  return jiraGetIssueForTarget(rowLessSourceTarget(settings), key, siteId)
}

export async function jiraUpdateIssue(
  settings: RuntimeJiraSettings,
  key: string,
  updates: JiraIssueUpdate,
  siteId?: string | null
): Promise<JiraMutationResult> {
  return jiraUpdateIssueForTarget(rowLessSourceTarget(settings), key, updates, siteId)
}

export async function jiraAddIssueComment(
  settings: RuntimeJiraSettings,
  key: string,
  body: string,
  siteId?: string | null
): Promise<JiraCommentResult> {
  return jiraAddIssueCommentForTarget(rowLessSourceTarget(settings), key, body, siteId)
}

export async function jiraIssueComments(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraComment[]> {
  return jiraIssueCommentsForTarget(rowLessSourceTarget(settings), key, siteId)
}

export async function jiraListProjects(
  settings: RuntimeJiraSettings,
  siteId?: JiraSiteSelection | null
): Promise<JiraProject[]> {
  return jiraListProjectsForTarget(rowLessSourceTarget(settings), siteId)
}

export async function jiraListIssueTypes(
  settings: RuntimeJiraSettings,
  projectIdOrKey: string,
  siteId?: string | null
): Promise<JiraIssueType[]> {
  const target = rowLessSourceTarget(settings)
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
  const target = rowLessSourceTarget(settings)
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
  return jiraListPrioritiesForTarget(rowLessSourceTarget(settings), siteId)
}

export async function jiraListTransitions(
  settings: RuntimeJiraSettings,
  key: string,
  siteId?: string | null
): Promise<JiraTransition[]> {
  return jiraListTransitionsForTarget(rowLessSourceTarget(settings), key, siteId)
}

export async function jiraGetProjectStatusOrder(
  settings: RuntimeJiraSettings,
  projectKey: string,
  siteId?: string | null
): Promise<JiraProjectStatusOrder> {
  const target = rowLessSourceTarget(settings)
  const args = { projectKey, siteId: siteId ?? undefined }
  return target.kind === 'environment'
    ? callRuntimeRpc<JiraProjectStatusOrder>(target, 'jira.getProjectStatusOrder', args, {
        timeoutMs: 30_000
      })
    : window.api.jira.getProjectStatusOrder(args)
}
