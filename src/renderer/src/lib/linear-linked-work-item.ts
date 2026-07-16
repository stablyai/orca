import type { LinearIssue } from '../../../shared/types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import {
  buildLinearWorkspaceSource,
  getUsableLinearBranchName
} from '../../../shared/new-workspace/workspace-source'

export function isLinearLinkedWorkItem(
  item: Pick<LinkedWorkItemSummary, 'provider' | 'linearIdentifier'> | null | undefined
): boolean {
  return item?.provider === 'linear' || Boolean(item?.linearIdentifier?.trim())
}

export function getLinearLinkedWorkItemBranchName(
  item:
    | Pick<LinkedWorkItemSummary, 'provider' | 'linearIdentifier' | 'linearBranchName'>
    | null
    | undefined
): string | undefined {
  return isLinearLinkedWorkItem(item)
    ? getUsableLinearBranchName(item?.linearBranchName)
    : undefined
}

export function buildLinearIssueLinkedWorkItem(issue: LinearIssue): LinkedWorkItemSummary {
  return buildLinearWorkspaceSource(issue)
}
