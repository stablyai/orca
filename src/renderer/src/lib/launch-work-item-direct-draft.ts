import { getWorkspaceIntentName, getWorkspaceSeedName } from '@/lib/new-workspace'
import { getLinearIssueWorkspaceName } from '../../../shared/workspace-name'
import { getLaunchableWorkItemDraftContent } from '@/lib/linked-work-item-context'
import type { LaunchableWorkItem } from '@/lib/launch-work-item-direct-types'

export async function getDirectWorkItemDraftContent(
  item: LaunchableWorkItem,
  _repoConnectionId: string | null
): Promise<string> {
  return getLaunchableWorkItemDraftContent(item)
}

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
