import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Worktree } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  getFolderWorkspaceRevealGroupKeys,
  getKnownSidebarWorktreeById,
  sidebarWorkspaceStillExists
} from './worktree-list-folder-reveal'
import { getProjectGroupHeaderKey } from './worktree-list-groups'

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-child',
    name: 'Refund workflow',
    folderPath: '/workspace/platform',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup>): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/workspace/platform',
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 1,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeWorktree(id: string): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/workspace/repo/${id}`,
    displayName: id,
    branch: id,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1
  }
}

describe('worktree list folder reveal', () => {
  it('resolves synthetic folder workspace ids as known sidebar worktrees', () => {
    const folderWorkspace = makeFolderWorkspace()
    const folderWorktree = getKnownSidebarWorktreeById(
      folderWorkspaceKey(folderWorkspace.id),
      new Map(),
      [folderWorkspace]
    )

    expect(folderWorktree).toMatchObject({
      id: folderWorkspaceKey(folderWorkspace.id),
      displayName: folderWorkspace.name,
      path: folderWorkspace.folderPath
    })
  })

  it('keeps pending reveals alive for folder workspaces missing from raw git worktrees', () => {
    const folderWorkspace = makeFolderWorkspace()
    const gitWorktree = makeWorktree('git-worktree-1')

    expect(
      sidebarWorkspaceStillExists(
        folderWorkspaceKey(folderWorkspace.id),
        [gitWorktree],
        [folderWorkspace]
      )
    ).toBe(true)
    expect(sidebarWorkspaceStillExists('missing-worktree', [gitWorktree], [folderWorkspace])).toBe(
      false
    )
  })

  it('returns project group keys from root to nested folder workspace owner', () => {
    const root = makeProjectGroup({ id: 'group-root', name: 'Company' })
    const child = makeProjectGroup({
      id: 'group-child',
      name: 'Platform',
      parentGroupId: root.id
    })
    const folderWorkspace = makeFolderWorkspace({ projectGroupId: child.id })

    expect(
      getFolderWorkspaceRevealGroupKeys(
        folderWorkspaceKey(folderWorkspace.id),
        [folderWorkspace],
        [child, root]
      )
    ).toEqual([getProjectGroupHeaderKey(root.id), getProjectGroupHeaderKey(child.id)])
  })
})
