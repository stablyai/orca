import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { worktree } from './worktree-list-groups-test-fixtures'
import { buildWorktreeManualOrderCatalog } from './worktree-manual-order-catalog'
import { getWorktreeIdFromHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

function row(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return { ...worktree, id, displayName: id, ...overrides }
}

function folder(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/tmp/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 200,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('buildWorktreeManualOrderCatalog', () => {
  it('includes filtered-capable git and folder rows in fallback order', () => {
    const catalog = buildWorktreeManualOrderCatalog({
      worktrees: [row('low', { sortOrder: 100 }), row('high', { sortOrder: 300 })],
      folderWorkspaces: [folder()]
    })

    expect(catalog.orderedKeys.map(getWorktreeIdFromHostIdentity)).toEqual([
      'high',
      'folder:folder-1',
      'low'
    ])
    expect(catalog.rankByKey.size).toBe(0)
  })

  it('ranks each same-id copy on its own host', () => {
    const sameId = 'repo::/same'
    const catalog = buildWorktreeManualOrderCatalog({
      worktrees: [
        row(sameId, { hostId: 'ssh:vm-a', manualOrder: 100 }),
        row(sameId, { hostId: 'ssh:vm-b', manualOrder: 900 }),
        row(sameId, { hostId: 'ssh:vm-c', manualOrder: undefined })
      ],
      folderWorkspaces: []
    })

    expect(catalog.orderedKeys).toEqual([
      `ssh:vm-b|${sameId}`,
      `ssh:vm-a|${sameId}`,
      `ssh:vm-c|${sameId}`
    ])
    expect([...catalog.rankByKey]).toEqual([
      [`ssh:vm-b|${sameId}`, 900],
      [`ssh:vm-a|${sameId}`, 100]
    ])
  })
})
