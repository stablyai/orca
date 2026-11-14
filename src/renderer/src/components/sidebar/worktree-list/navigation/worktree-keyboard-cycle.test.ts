import { describe, expect, it } from 'vitest'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { FolderWorkspaceRow } from '../../../../../../shared/sidebar-list/row-types'
import { getCyclableWorktreeIds } from './worktree-keyboard-cycle'

const folderRow: FolderWorkspaceRow = {
  type: 'folder-workspace',
  key: 'folder-workspace:folder-1',
  folderWorkspace: {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'Folder 1',
    folderPath: '/group-1/folder-1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  },
  projectGroup: {
    id: 'group-1',
    name: 'Group 1',
    parentPath: '/group-1',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  },
  depth: 0,
  groupDepth: 0
}

describe('getCyclableWorktreeIds', () => {
  const repo = {
    id: 'repo-1',
    path: '/repo-1',
    displayName: 'Repo 1',
    badgeColor: '#737373',
    addedAt: 1
  }

  function worktree(id: string, isPinned = false): HostSectionRow & { type: 'item' } {
    return {
      type: 'item',
      rowKey: `row:${id}`,
      sectionKey: isPinned ? 'pinned' : 'repo:repo-1',
      worktree: { id, repoId: repo.id, isPinned } as never,
      repo: repo as never,
      depth: 0,
      groupDepth: 0,
      isLastLineageChild: false,
      lineageChildCount: 0
    }
  }

  it('keeps folder placement while preferring a pinned worktree natural row', () => {
    const rows = [
      worktree('dup', true),
      folderRow,
      { ...worktree('dup'), rowKey: 'row:dup-natural' },
      worktree('b')
    ]

    expect(getCyclableWorktreeIds(rows, 'duplicate-in-groups')).toEqual([
      'folder:folder-1',
      'dup',
      'b'
    ])
  })
})
