import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/types'
import type { TreeNode } from './file-explorer-types'

export type AddProjectFromFolderModalData = {
  folderPath: string
  connectionId?: string
}

export function canShowAddAsProjectAction(node: TreeNode, activeRepo: Repo | null): boolean {
  return node.isDirectory && Boolean(activeRepo && isFolderRepo(activeRepo))
}

export function buildAddProjectFromFolderModalData(
  node: TreeNode,
  activeRepo: Repo
): AddProjectFromFolderModalData {
  return {
    folderPath: node.path,
    ...(activeRepo.connectionId ? { connectionId: activeRepo.connectionId } : {})
  }
}
