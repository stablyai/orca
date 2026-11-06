import { parseWorkspaceKey, worktreeWorkspaceKey, type WorkspaceKey } from '../workspace-scope'
import type { Worktree } from './types'

export function workspaceKeyOfRow(row: Pick<Worktree, 'id'>): WorkspaceKey {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: folder rows carry their folder WorkspaceKey as id (folderWorkspaceToWorktree).
  return row.id.startsWith('folder:') ? (row.id as WorkspaceKey) : worktreeWorkspaceKey(row.id)
}

/** A row's cross-store instance identity. A folder workspace's id is minted per creation and never
 * reused, so it is the folder's instance; folder rows carry no instanceId of their own. */
export function lineageInstanceIdOfRow(
  row: Pick<Worktree, 'id' | 'instanceId'>
): string | undefined {
  const scope = parseWorkspaceKey(row.id)
  return scope?.type === 'folder' ? scope.folderWorkspaceId : row.instanceId || undefined
}
