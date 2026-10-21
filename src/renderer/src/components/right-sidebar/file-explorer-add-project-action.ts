import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { TreeNode } from './file-explorer-types'

export type AddProjectFromFolderModalData = {
  folderPath: string
  runtimeEnvironmentId: string | null
}

// Why not an `ssh:` folder: only a paired server adds projects on an SSH host.
export function canShowAddAsProjectAction(node: TreeNode, activeRepo: Repo | null): boolean {
  if (!node.isDirectory || !activeRepo || !isFolderRepo(activeRepo)) {
    return false
  }
  return parseExecutionHostId(getRepoExecutionHostId(activeRepo))?.kind !== 'ssh'
}

export function buildAddProjectFromFolderModalData(
  node: TreeNode,
  activeRepo: Repo
): AddProjectFromFolderModalData {
  // Why: subfolder paths must stay on their owning repo host, not the mutable global selection.
  const host = parseExecutionHostId(getRepoExecutionHostId(activeRepo))
  return {
    folderPath: node.path,
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
  }
}
