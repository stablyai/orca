import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { findWorktreeMetaFolderWorkspace } from './use-worktree-meta-workspace'

function folder(name: string, sourceHostId: 'local' | 'ssh:builder'): FolderWorkspace {
  return {
    id: 'shared-folder',
    projectGroupId: 'shared-group',
    name,
    folderPath: `/${name}`,
    connectionId: sourceHostId === 'local' ? null : 'builder',
    executionHostId: 'runtime:env-1',
    runtimeSourceExecutionHostId: sourceHostId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('worktree meta folder owner selection', () => {
  it('prefers opening-row owner evidence for same-ID paired folders', () => {
    const local = folder('Local', 'local')
    const ssh = folder('SSH', 'ssh:builder')

    expect(
      findWorktreeMetaFolderWorkspace({
        worktreeId: folderWorkspaceKey(local.id),
        ownerExecutionHostId: 'ssh:builder',
        activeWorktreeId: folderWorkspaceKey(local.id),
        activeWorkspaceExecutionHostId: 'local',
        folderWorkspaces: [local, ssh]
      })
    ).toBe(ssh)
  })

  it('uses active owner evidence when the opening row has none', () => {
    const local = folder('Local', 'local')
    const ssh = folder('SSH', 'ssh:builder')
    const worktreeId = folderWorkspaceKey(local.id)

    expect(
      findWorktreeMetaFolderWorkspace({
        worktreeId,
        ownerExecutionHostId: null,
        activeWorktreeId: worktreeId,
        activeWorkspaceExecutionHostId: 'local',
        folderWorkspaces: [ssh, local]
      })
    ).toBe(local)
  })

  it('fails closed without owner evidence for duplicate IDs', () => {
    const local = folder('Local', 'local')
    const ssh = folder('SSH', 'ssh:builder')

    expect(
      findWorktreeMetaFolderWorkspace({
        worktreeId: folderWorkspaceKey(local.id),
        ownerExecutionHostId: null,
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        folderWorkspaces: [local, ssh]
      })
    ).toBeNull()
  })
})
