import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import type { HostSectionRow } from './host-section-rows'
import { getRenderedWorktreesInSidebarOrder } from './worktree-sidebar-row-preference'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo-1',
  displayName: 'Repo 1',
  badgeColor: '#737373',
  addedAt: 1
}

function worktree(id: string, isPinned = false): Worktree {
  return {
    id,
    repoId: repo.id,
    path: `/repo-1/${id}`,
    displayName: id,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned,
    sortOrder: 1,
    lastActivityAt: 1
  }
}

function item(workspace: Worktree, sectionKey: string): HostSectionRow {
  return {
    type: 'item',
    rowKey: `${sectionKey}:${workspace.id}`,
    sectionKey,
    worktree: workspace,
    repo,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

const projectGroup: ProjectGroup = {
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
}

const folderWorkspace: FolderWorkspace = {
  id: 'folder-1',
  projectGroupId: projectGroup.id,
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
}

describe('getRenderedWorktreesInSidebarOrder', () => {
  it('keeps folder workspaces in visual order while preferring natural pinned rows', () => {
    const pinned = worktree('pinned', true)
    const afterFolder = worktree('after-folder')
    const rows: HostSectionRow[] = [
      item(pinned, 'pinned'),
      {
        type: 'folder-workspace',
        key: 'folder-workspace:folder-1',
        folderWorkspace,
        projectGroup,
        depth: 0,
        groupDepth: 0
      },
      item(pinned, 'repo:repo-1'),
      item(afterFolder, 'repo:repo-1')
    ]

    expect(
      getRenderedWorktreesInSidebarOrder(rows, 'duplicate-in-groups').map(({ id }) => id)
    ).toEqual(['folder:folder-1', 'pinned', 'after-folder'])
  })
})
