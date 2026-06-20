import type { LinearIssue } from '../../../shared/types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getLinearOrganizationUrlKeyFromIssueUrl } from '../../../shared/linear-links'

export function isLinearLinkedWorkItem(
  item: Pick<LinkedWorkItemSummary, 'linearIdentifier'> | null | undefined
): boolean {
  return Boolean(item?.linearIdentifier)
}

// Why: launch prompts carry only the trusted Linear pointer (identifier,
// title, URL) — never a ticket snapshot. Agents fetch full ticket data via
// the `orca linear` CLI, so no rendered context rides on the work item.
export function buildLinearIssueLinkedWorkItem(issue: LinearIssue): LinkedWorkItemSummary {
  const organizationUrlKey = getLinearOrganizationUrlKeyFromIssueUrl(issue.url)
  return {
    type: 'issue',
    provider: 'linear',
    // Why: Linear issue identifiers are strings; keep numeric issue metadata
    // empty while preserving the real source through `linearIdentifier`.
    number: 0,
    title: issue.title,
    url: issue.url,
    linearIdentifier: issue.identifier,
    ...(issue.workspaceId ? { linearWorkspaceId: issue.workspaceId } : {}),
    ...(organizationUrlKey
      ? {
          linearOrganizationUrlKey: organizationUrlKey
        }
      : {})
  }
}
