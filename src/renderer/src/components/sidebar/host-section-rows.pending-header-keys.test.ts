import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'
import { addHostSectionRows } from './host-section-rows'
import { getRenderRowKey } from './worktree-list-virtual-rows'

function repo(id: string, connectionId: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId
  }
}

function item(id: string, project: Repo): Extract<Row, { type: 'item' }> {
  const worktree: Worktree = {
    id,
    repoId: project.id,
    path: `/${project.id}/${id}`,
    branch: `refs/heads/${id}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: false,
    displayName: id,
    sortOrder: 0,
    lastActivityAt: 0
  }
  return {
    type: 'item',
    rowKey: `all:${id}`,
    sectionKey: 'all',
    worktree,
    repo: project,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}

// Why: a status/"All" header repeats above every host-owned run. Its copies
// must carry the section's hostId or their render keys collide, corrupting
// React reconciliation and the scroll anchor's row index.
describe('addHostSectionRows pass-through pending header keys', () => {
  it('stamps each duplicated pass-through header with its section host', () => {
    const repoA = repo('project-a', 'ssh-1')
    const repoB = repo('project-b', 'ssh-2')
    const allHeader: Extract<Row, { type: 'header' }> = {
      type: 'header',
      key: 'all',
      label: 'All',
      count: 2,
      tone: 'text-foreground'
    }
    const rows: Row[] = [allHeader, item('wt-a', repoA), item('wt-b', repoB)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' },
        { id: 'ssh:ssh-2', kind: 'ssh', label: 'Runner', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    const renderKeys = sectioned.map((row) => getRenderRowKey(row))
    expect(renderKeys).toContain('hdr:ssh:ssh-1:all')
    expect(renderKeys).toContain('hdr:ssh:ssh-2:all')
    expect(new Set(renderKeys).size).toBe(renderKeys.length)
  })
})
