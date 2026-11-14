import { resolveGitHubWorkItemIdentity } from '../../../../../../shared/new-workspace/github-work-item-identity'
import {
  getWorkspaceIntentName,
  getLinearIssueWorkspaceName
} from '../../../../../../shared/workspace-name'
import { getWorkspaceSeedName } from '@/lib/workspace/creation/new-workspace'
import type { LaunchableWorkItem } from '@/lib/workspace/creation/work-item/launch-work-item-direct-types'

export function getDirectWorkItemWorkspaceNames(
  item: LaunchableWorkItem,
  itemType: LaunchableWorkItem['type'],
  itemNumber: number | null
) {
  const workspaceIntentName =
    itemNumber !== null
      ? getWorkspaceIntentName({
          sourceText: item.pasteContent,
          workItem: { ...item, type: itemType, number: itemNumber }
        })
      : null
  const workspaceName = getWorkspaceSeedName({
    explicitName: item.linearIdentifier
      ? getLinearIssueWorkspaceName({ identifier: item.linearIdentifier, title: item.title })
      : (workspaceIntentName?.seedName ?? ''),
    prompt: '',
    linkedIssueNumber: itemType === 'issue' ? (itemNumber ?? null) : null,
    linkedPR: itemType === 'pr' ? (itemNumber ?? null) : null
  })
  return { workspaceIntentName, workspaceName }
}

export function getDirectWorkItemIdentity(item: LaunchableWorkItem) {
  const identity =
    item.number !== null && (item.type === 'issue' || item.type === 'pr')
      ? resolveGitHubWorkItemIdentity({ type: item.type, number: item.number, url: item.url })
      : null
  return { itemType: identity?.type ?? item.type, itemNumber: identity?.number ?? item.number }
}
