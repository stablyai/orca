import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/types'
import type { TreeNode } from './file-explorer-types'

export type AddProjectFromFolderModalData = {
  folderPath: string
  connectionId?: string
  runtimeEnvironmentId?: string | null
}

export function canShowAddAsProjectAction(node: TreeNode, activeRepo: Repo | null): boolean {
  return node.isDirectory && Boolean(activeRepo && isFolderRepo(activeRepo))
}

export function buildAddProjectFromFolderModalData(
  node: TreeNode,
  activeRepo: Repo
): AddProjectFromFolderModalData {
  // Why: subfolder paths must stay on their owning repo host, not the mutable global selection.
  const host = parseExecutionHostId(getRepoExecutionHostId(activeRepo))
  if (host?.kind === 'ssh') {
    return { folderPath: node.path, connectionId: host.targetId }
  }
  return {
    folderPath: node.path,
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
  }
}
