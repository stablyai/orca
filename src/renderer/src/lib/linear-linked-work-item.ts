import type { LinearIssue } from '../../../shared/types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { getLinearOrganizationUrlKeyFromIssueUrl } from '../../../shared/linear-links'

export function isLinearLinkedWorkItem(
  item: Pick<LinkedWorkItemSummary, 'provider' | 'linearIdentifier'> | null | undefined
): boolean {
  return item?.provider === 'linear' || Boolean(item?.linearIdentifier?.trim())
}

export function buildLinearIssueLinkedWorkItem(issue: LinearIssue): LinkedWorkItemSummary {
  const organizationUrlKey = getLinearOrganizationUrlKeyFromIssueUrl(issue.url)
  return {
    type: 'issue',
    provider: 'linear',
    // Why: Linear issue prose must not enter prompt metadata; keep only the
    // string identifier/link and leave numeric issue metadata empty.
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
