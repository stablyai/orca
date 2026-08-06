import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/types'
import { jiraGetProjectStatusOrder, type RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { createMetadataRequestStore, loadMetadata } from '@/hooks/metadata-request-cache'

export type TaskPageJiraProjectScope = {
  key: string
  projectKey: string
  siteId: string
}

const jiraProjectStatusOrderStore = createMetadataRequestStore<JiraProjectStatusOrder>()

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
  // Why: a project key can exist on multiple Jira sites and runtimes; all three
  // identities must participate in caching to preserve SSH and multi-site parity.
  const cacheKey = getTaskPageJiraStatusOrderScopeKey(runtimeScopeKey, projectScope)
  return loadMetadata(jiraProjectStatusOrderStore, cacheKey, () =>
    jiraGetProjectStatusOrder(settings, projectScope.projectKey, projectScope.siteId)
  ).catch((error: unknown) => {
    // Why: older remote runtimes do not expose this optional metadata method;
    // an empty order preserves the deterministic alphabetical fallback.
    console.warn('[jira] Failed to load project status order:', error)
    return { statusIdsByColumn: [] }
  })
}
