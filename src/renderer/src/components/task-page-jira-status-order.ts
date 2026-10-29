import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'
import { getEnvironmentRuntimeContextKey } from '@/lib/provider-runtime-context'
import { jiraGetProjectStatusOrder, type RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { createMetadataRequestStore, loadMetadata } from '@/hooks/metadata-request-cache'

export type TaskPageJiraProjectScope = {
  key: string
  projectKey: string
  siteId: string
}

const jiraProjectStatusOrderStore = createMetadataRequestStore<JiraProjectStatusOrder>()

export function getTaskPageJiraStatusOrderRuntimeScopeKey(
  sourceScopeKey: string,
  owner: RuntimeClientTarget | null
): string {
  return JSON.stringify([
    sourceScopeKey,
    owner ? getEnvironmentRuntimeContextKey(runtimeTargetEnvironmentId(owner)) : null
  ])
}

export function getTaskPageJiraStatusOrderScopeKey(
  runtimeScopeKey: string,
  projectScope: TaskPageJiraProjectScope
): string {
  return `${encodeURIComponent(runtimeScopeKey)}:${projectScope.key}`
}

function issueProjectScope(issue: JiraIssue): TaskPageJiraProjectScope | null {
  const projectKey = issue.project.key.trim()
  const siteId = issue.siteId?.trim() || issue.project.siteId?.trim()
  if (!projectKey || !siteId) {
    return null
  }
  return {
    key: `${encodeURIComponent(siteId)}:${encodeURIComponent(projectKey)}`,
    projectKey,
    siteId
  }
}

export function getSingleJiraProjectScope(
  issues: readonly JiraIssue[]
): TaskPageJiraProjectScope | null {
  let onlyScope: TaskPageJiraProjectScope | null = null
  for (const issue of issues) {
    const scope = issueProjectScope(issue)
    if (!scope || (onlyScope && onlyScope.key !== scope.key)) {
      return null
    }
    onlyScope = scope
  }
  return onlyScope
}

export function loadTaskPageJiraProjectStatusOrder(
  settings: RuntimeJiraSettings,
  runtimeScopeKey: string,
  projectScope: TaskPageJiraProjectScope
): Promise<JiraProjectStatusOrder> {
  // Cache by runtime, Jira site and project because project keys can repeat across hosts and sites.
  const cacheKey = getTaskPageJiraStatusOrderScopeKey(runtimeScopeKey, projectScope)
  return loadMetadata(jiraProjectStatusOrderStore, cacheKey, () =>
    jiraGetProjectStatusOrder(settings, projectScope.projectKey, projectScope.siteId)
  ).catch((error: unknown) => {
    // Older hosts lack this optional metadata method; empty order preserves alphabetical fallback.
    console.warn('[jira] Failed to load project status order:', error)
    return { statusIdsByColumn: [] }
  })
}
