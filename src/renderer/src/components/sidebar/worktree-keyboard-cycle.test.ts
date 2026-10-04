import { describe, expect, it } from 'vitest'
import type { HostSectionRow } from './host-section-rows'
import type { FolderWorkspaceRow } from './worktree-list/grouping/row-types'
import {
  getCyclableRowIdentity,
  getCyclableWorktreeRows,
  getCyclableWorktreeIds,
  getCyclableWorktrees,
  resolveActiveCycleIdentity,
  resolveCycledWorktreeId
} from './worktree-keyboard-cycle'

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

describe('resolveCycledWorktreeId', () => {
  const worktreeIds = ['a', 'b', 'c']

  it('steps to the next and previous worktree', () => {
    expect(resolveCycledWorktreeId({ worktreeIds, activeWorktreeId: 'a', direction: 'down' })).toBe(
      'b'
    )
    expect(resolveCycledWorktreeId({ worktreeIds, activeWorktreeId: 'b', direction: 'up' })).toBe(
      'a'
    )
  })

  it('wraps around at both ends', () => {
    expect(resolveCycledWorktreeId({ worktreeIds, activeWorktreeId: 'c', direction: 'down' })).toBe(
      'a'
    )
    expect(resolveCycledWorktreeId({ worktreeIds, activeWorktreeId: 'a', direction: 'up' })).toBe(
      'c'
    )
  })

  it('enters from the matching end when the active worktree is not cyclable', () => {
    // Why: the active worktree stays selected inside a group the user collapsed,
    // so it is absent from the cyclable list; arrowing should not always jump to
    // the top.
    expect(
      resolveCycledWorktreeId({ worktreeIds, activeWorktreeId: 'hidden', direction: 'down' })
    ).toBe('a')
    expect(
      resolveCycledWorktreeId({ worktreeIds, activeWorktreeId: 'hidden', direction: 'up' })
    ).toBe('c')
    expect(
      resolveCycledWorktreeId({ worktreeIds, activeWorktreeId: null, direction: 'down' })
    ).toBe('a')
  })

  it('has nothing to cycle to when every group is collapsed', () => {
    expect(
      resolveCycledWorktreeId({ worktreeIds: [], activeWorktreeId: 'a', direction: 'down' })
    ).toBe(null)
  })
})

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
      lineageTrail: [],
      isLastLineageChild: false,
      lineageChildCount: 0
    }
  }

  it('keeps a pinned worktree cyclable when only its natural group is collapsed', () => {
    // Why: `single-location` renders a pinned worktree solely under Pinned, so
    // rebuilding the cycle list from natural groups alone would drop it.
    const rows: HostSectionRow[] = [worktree('pinned-a', true), worktree('plain-b')]

    expect(getCyclableWorktreeIds(rows, 'single-location')).toEqual(['pinned-a', 'plain-b'])
  })

  it('counts a duplicated pinned worktree once', () => {
    const rows: HostSectionRow[] = [
      worktree('dup', true),
      { ...worktree('dup'), rowKey: 'row:dup-natural' },
      worktree('plain-b')
    ]

    expect(getCyclableWorktreeIds(rows, 'duplicate-in-groups')).toEqual(['dup', 'plain-b'])
  })

  it('keeps same-id rows on different hosts independently cyclable', () => {
    const rows: HostSectionRow[] = [
      {
        ...worktree('shared'),
        worktree: { id: 'shared', repoId: repo.id, hostId: 'local' } as never
      },
      {
        ...worktree('shared'),
        rowKey: 'row:shared:ssh',
        worktree: { id: 'shared', repoId: repo.id, hostId: 'ssh:host-b' } as never
      }
    ]

    expect(getCyclableWorktrees(rows, 'single-location').map((item) => item.hostId)).toEqual([
      'local',
      'ssh:host-b'
    ])
  })

  it('includes folder workspaces between git worktrees in visible order', () => {
    const rows = [worktree('a'), folderRow, worktree('b')]

    expect(getCyclableWorktreeIds(rows, 'single-location')).toEqual(['a', 'folder:folder-1', 'b'])
  })

  it('anchors both directions on the active folder workspace', () => {
    const rows = getCyclableWorktreeRows(
      [worktree('a'), folderRow, worktree('b')],
      'single-location'
    )
    const activeWorktreeId = resolveActiveCycleIdentity({
      rows,
      activeWorktreeId: 'folder:folder-1',
      activeWorkspaceExecutionHostId: 'local'
    })
    const worktreeIds = rows.map(getCyclableRowIdentity)

    expect(resolveCycledWorktreeId({ worktreeIds, activeWorktreeId, direction: 'up' })).toBe(
      getCyclableRowIdentity(rows[0])
    )
    expect(resolveCycledWorktreeId({ worktreeIds, activeWorktreeId, direction: 'down' })).toBe(
      getCyclableRowIdentity(rows[2])
    )
  })

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

  it('keeps folder keys distinct from git ids and preserves same-id host ownership', () => {
    const otherHostFolder = {
      ...folderRow,
      folderWorkspace: { ...folderRow.folderWorkspace, executionHostId: 'ssh:host-b' as const }
    }
    const rows = getCyclableWorktreeRows(
      [worktree('folder-1'), folderRow, otherHostFolder],
      'single-location'
    )

    expect(rows.map(getCyclableRowIdentity)).toEqual([
      'local|folder-1',
      'local|folder:folder-1',
      'ssh:host-b|folder:folder-1'
    ])
  })

  it('drops worktrees the sidebar elided inside a collapsed host section', () => {
    // Why: addHostSectionRows omits a collapsed host's rows entirely, so anything
    // it removed must not stay reachable by arrowing.
    const rows: HostSectionRow[] = [
      {
        type: 'host-header',
        key: 'host:local',
        hostId: 'local' as never,
        kind: 'local',
        label: 'This computer',
        detail: '',
        health: 'local',
        collapsed: true,
        count: 1
      },
      worktree('visible-after-host')
    ]

    expect(getCyclableWorktreeIds(rows, 'single-location')).toEqual(['visible-after-host'])
  })
})
