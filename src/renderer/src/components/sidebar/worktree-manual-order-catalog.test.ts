import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { worktree } from './worktree-list-groups-test-fixtures'
import { buildWorktreeManualOrderCatalog } from './worktree-manual-order-catalog'

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

    expect(catalog.orderedIds).toEqual(['high', 'folder:folder-1', 'low'])
    expect(catalog.rankByWorktreeId.size).toBe(0)
  })

  it('treats a same-id host cluster as durable only when every owner agrees', () => {
    const sameId = 'repo::/same'
    const complete = buildWorktreeManualOrderCatalog({
      worktrees: [
        row(sameId, { hostId: 'local', manualOrder: 900 }),
        row(sameId, { hostId: 'ssh:openclaw', manualOrder: 900 })
      ],
      folderWorkspaces: []
    })
    const incomplete = buildWorktreeManualOrderCatalog({
      worktrees: [
        row(sameId, { hostId: 'local', manualOrder: 900 }),
        row(sameId, { hostId: 'ssh:openclaw', manualOrder: undefined })
      ],
      folderWorkspaces: []
    })

    expect(complete.orderedIds).toEqual([sameId])
    expect(complete.rankByWorktreeId.get(sameId)).toBe(900)
    expect(incomplete.rankByWorktreeId.has(sameId)).toBe(false)
  })
})
