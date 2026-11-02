import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import type { LinearIssue } from '../../../shared/linear/issue-types'
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

export function buildLinearIssueComposerData(issue: LinearIssue, source: TaskSourceContext | null) {
  const sourceContext = source
    ? normalizeTaskSourceContext({
        ...source,
        providerIdentity: {
          provider: 'linear',
          workspaceId: issue.workspaceId ?? null,
          workspaceName: issue.workspaceName ?? null,
          teamId: issue.team.id,
          teamKey: issue.team.key
        },
        accountLabel: issue.workspaceName ?? null
      })
    : null
  return {
    prefilledName: getLinearIssueWorkspaceName(issue),
    linkedWorkItem: buildLinearIssueLinkedWorkItem(issue),
    ...(sourceContext ? { taskSourceContext: sourceContext } : {})
  }
}
