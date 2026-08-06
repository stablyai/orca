import type { WorkspaceKey } from '../../../../shared/types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../../../../shared/workspace-scope'

export function resolveCreateParentWorkspace(
  activeWorkspaceKey: string | null | undefined,
  requestedParent: WorkspaceKey | null | undefined
): WorkspaceKey | undefined {
  if (requestedParent === null) {
    return undefined
  }
  if (requestedParent) {
    return requestedParent
  }
  const activeScope = parseWorkspaceKey(activeWorkspaceKey ?? '')
  return activeScope?.type === 'folder'
    ? folderWorkspaceKey(activeScope.folderWorkspaceId)
    : undefined
}
