import type { FolderWorkspace } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

export function getRemovedFolderWorkspaceKeys(
  previous: readonly Pick<FolderWorkspace, 'id'>[],
  next: readonly Pick<FolderWorkspace, 'id'>[]
): string[] {
  const survivingKeys = new Set(next.map((workspace) => folderWorkspaceKey(workspace.id)))
  return [
    ...new Set(
      previous
        .map((workspace) => folderWorkspaceKey(workspace.id))
        .filter((workspaceKey) => !survivingKeys.has(workspaceKey))
    )
  ]
}
