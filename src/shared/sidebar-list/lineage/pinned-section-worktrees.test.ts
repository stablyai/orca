import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../worktree/types'
import { getWorktreeHostIdentity } from '../../worktree/host-qualified-identity'
import { folderWorkspaceRepoId } from '../../folder-workspaces/folder-workspace-worktree'
import { getSidebarLineageChildren } from './pinned-section-worktrees'

function row(repoId: string, name: string): Worktree {
  return {
    id: `${repoId}::/${name}`,
    repoId,
    path: `/${name}`,
    head: 'abc123',
    branch: name,
    isBare: false,
    isMainWorktree: false,
    displayName: name,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1
  }
}

const folder = row(folderWorkspaceRepoId('group'), 'folder')
const alpha = row('alpha', 'feature')
const beta = row('beta', 'spawned')

function childNames(nestsAcrossProjects?: (child: Worktree) => boolean): string[][] {
  const parents = new Map([
    [getWorktreeHostIdentity(alpha), getWorktreeHostIdentity(folder)],
    [getWorktreeHostIdentity(beta), getWorktreeHostIdentity(alpha)]
  ])
  const children = getSidebarLineageChildren(
    [alpha, beta],
    {},
    new Map(),
    [],
    parents,
    [folder],
    nestsAcrossProjects
  )
  return [folder, alpha].map((parent) =>
    (children.get(getWorktreeHostIdentity(parent)) ?? []).map((child) => child.id)
  )
}

describe('getSidebarLineageChildren across projects', () => {
  it('nests a child under another project by default', () => {
    expect(childNames()).toEqual([[alpha.id], [beta.id]])
  })

  it('keeps a Tree child in its own project, but a folder still nests any project', () => {
    expect(childNames(() => false)).toEqual([[alpha.id], []])
  })

  it('still nests a Tree child whose project is hidden, so its folder lane keeps it', () => {
    expect(childNames((child) => child.repoId === 'beta')).toEqual([[alpha.id], [beta.id]])
  })
})
