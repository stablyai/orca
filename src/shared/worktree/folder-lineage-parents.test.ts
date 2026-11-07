import { describe, expect, it } from 'vitest'
import { getFolderWorkspaceWorktree } from '../folder-workspaces/folder-workspace-worktree'
import { getWorktreeHostIdentity } from './host-qualified-identity'
import { pickFolderLineageRecord, resolveFolderLineageParents } from './folder-lineage-parents'
import type { WorkspaceLineageEdge } from './lineage-types'
import type { Worktree } from './types'

const folderOn = (id: string, executionHostId: 'local' | 'runtime:env-1') =>
  getFolderWorkspaceWorktree({
    id,
    projectGroupId: 'g',
    name: id,
    folderPath: `/${id}`,
    executionHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  })
const child = (
  hostId: 'local' | 'runtime:env-1',
  instanceId: string,
  inline?: WorkspaceLineageEdge
): Worktree => ({
  id: 'repo::/src/api',
  hostId,
  instanceId,
  repoId: 'repo',
  path: '/src/api',
  branch: 'api',
  head: '',
  isBare: false,
  isMainWorktree: false,
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  comment: '',
  isUnread: false,
  isPinned: false,
  displayName: 'api',
  sortOrder: 0,
  lastActivityAt: 0,
  ...(inline ? { workspaceLineage: inline } : {})
})
const edge = (folder: string, childInstanceId: string): WorkspaceLineageEdge => ({
  parentWorkspaceKey: `folder:${folder}`,
  parentInstanceId: folder,
  childInstanceId
})

describe('folder parents of same-id workspaces on two machines', () => {
  it('places each by its own record when the merged bucket holds only one', () => {
    const local = child('local', 'local-instance')
    const remote = child('runtime:env-1', 'remote-instance', edge('f-remote', 'remote-instance'))
    const rows = new Map(
      [local, remote, folderOn('f-local', 'local'), folderOn('f-remote', 'runtime:env-1')].map(
        (row) => [getWorktreeHostIdentity(row), row]
      )
    )
    const bucket = edge('f-local', 'local-instance')
    const parents = resolveFolderLineageParents(rows, (row) => pickFolderLineageRecord(bucket, row))
    expect([...parents].map(([identity, folder]) => [identity, folder.id]).sort()).toEqual(
      [
        [getWorktreeHostIdentity(local), 'folder:f-local'],
        [getWorktreeHostIdentity(remote), 'folder:f-remote']
      ].sort()
    )
  })
})
