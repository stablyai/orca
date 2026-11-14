import { describe, expect, it } from 'vitest'
import type { GroupHeaderRow } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
import { getProjectGroupColors, getProjectGroupThreads } from './project-group-colors'

function group(key: string, color: string | null, depth = 0): GroupHeaderRow {
  return {
    type: 'header',
    key,
    count: 1,
    icon: { kind: 'project' },
    projectGroupDepth: depth,
    projectGroup: {
      id: key,
      name: key,
      color,
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      createdAt: 0,
      updatedAt: 0
    }
  }
}

function project(depth: number): GroupHeaderRow {
  return {
    type: 'header',
    key: 'repo:one',
    count: 1,
    icon: { kind: 'project' },
    repo,
    projectGroupDepth: depth
  }
}

const item: RenderRow = {
  type: 'item',
  rowKey: 'one',
  sectionKey: 'repo:one',
  worktree,
  repo,
  depth: 0,
  groupDepth: 1,
  isLastLineageChild: false,
  lineageChildCount: 0
}

describe('getProjectGroupColors', () => {
  it('connects groups, projects and workspace families, ending each rail at its last child', () => {
    const rows: RenderRow[] = [
      group('work', '#8b5cf6'),
      project(1),
      item,
      { ...item, depth: 1, rowKey: 'child' },
      { ...item, rowKey: 'sibling' },
      group('nested', null, 1),
      project(2),
      item,
      group('personal', '#14b8a6'),
      project(1)
    ]
    const frames = [null, null, null, 2, null, null, null, null, null, null].map((parent) => ({
      parent
    }))
    const threads = getProjectGroupThreads(rows, 'repo', frames)
    expect(threads.parents).toEqual([null, 0, 1, 2, 1, 0, 5, 6, null, 8])
    expect(threads.lastChildren).toEqual([5, 4, 3, null, null, 6, 7, null, 9, null])
  })

  it('leaves pinned lanes, other grouping modes and host boundaries disconnected', () => {
    const rows: RenderRow[] = [
      group('work', '#8b5cf6'),
      project(1),
      item,
      { type: 'header', key: '__pinned__', count: 1, icon: { kind: 'pinned' } },
      item,
      { ...item, depth: 1, rowKey: 'pinned-child' },
      {
        type: 'host-header',
        key: 'host:remote',
        hostId: 'runtime:remote',
        kind: 'runtime',
        label: 'Remote',
        detail: '',
        health: 'available',
        collapsed: false,
        count: 1
      },
      project(0),
      item
    ]
    const frames = [null, null, null, null, null, 4, null, null, null].map((parent) => ({
      parent
    }))
    expect(getProjectGroupThreads(rows, 'repo', frames).parents).toEqual([
      null,
      0,
      1,
      null,
      null,
      null,
      null,
      null,
      7
    ])
    expect(getProjectGroupThreads(rows, 'workspace-status', frames)).toEqual({
      parents: [],
      lastChildren: []
    })
  })

  it('tints the whole group, including folder workspaces and project notices', () => {
    const header = group('work', '#8b5cf6')
    const rows: RenderRow[] = [
      header,
      {
        type: 'folder-workspace',
        key: 'folder:one',
        depth: 0,
        groupDepth: 1,
        projectGroup: {
          id: 'work',
          name: 'Work',
          color: '#8b5cf6',
          parentPath: '/work',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          createdAt: 0,
          updatedAt: 0
        },
        folderWorkspace: {
          id: 'one',
          projectGroupId: 'work',
          name: 'Notes',
          folderPath: '/work/notes',
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }
      },
      project(1),
      item,
      { type: 'pending-creation', key: 'pending:one', creationId: 'one', repo },
      {
        type: 'imported-worktrees-card',
        key: 'imported:one',
        placement: 'repo-group',
        repo,
        hiddenWorktrees: []
      },
      project(0),
      item
    ]
    const colors = getProjectGroupColors(rows, 'repo')
    expect(
      getProjectGroupThreads(
        rows,
        'repo',
        rows.map(() => ({ parent: null }))
      ).parents
    ).toEqual([null, 0, 0, 2, 2, 2, null, 6])
    expect(colors.map((entry) => entry?.color ?? null)).toEqual([
      '#8b5cf6',
      '#8b5cf6',
      '#8b5cf6',
      '#8b5cf6',
      '#8b5cf6',
      '#8b5cf6',
      null,
      null
    ])
    expect(colors[0]).toBe(colors[5])
  })

  it('inherits parent colors and keeps nested and adjacent groups distinct', () => {
    const rows = [
      group('work', '#ef4444'),
      project(1),
      group('nested', '#14b8a6', 1),
      project(2),
      group('inherited', null, 1),
      project(2),
      group('personal', '#ef4444'),
      group('uncolored', null),
      project(1)
    ]
    const colors = getProjectGroupColors(rows, 'repo')
    expect(colors.map((entry) => entry?.color ?? null)).toEqual([
      '#ef4444',
      '#ef4444',
      '#14b8a6',
      '#14b8a6',
      '#ef4444',
      '#ef4444',
      '#ef4444',
      null,
      null
    ])
    expect(colors[0]).not.toBe(colors[6])
  })

  it('does not leak colors into pinned lanes or across host sections', () => {
    const rows: RenderRow[] = [
      group('work', '#ef4444'),
      item,
      { type: 'header', key: '__pinned__', count: 1, icon: { kind: 'pinned' } },
      item,
      group('work', '#14b8a6'),
      item,
      {
        type: 'host-header',
        key: 'host:remote',
        hostId: 'runtime:remote',
        kind: 'runtime',
        label: 'Remote',
        detail: '',
        health: 'available',
        collapsed: false,
        count: 1
      },
      project(0),
      item,
      { ...group('work', '#8b5cf6'), hostId: 'runtime:remote' },
      item
    ]
    expect(getProjectGroupColors(rows, 'repo').map((entry) => entry?.color ?? null)).toEqual([
      '#ef4444',
      '#ef4444',
      null,
      null,
      '#14b8a6',
      '#14b8a6',
      null,
      null,
      null,
      '#8b5cf6',
      '#8b5cf6'
    ])
  })

  it('normalizes persisted colors and ignores invalid colors and other grouping modes', () => {
    const rows = [
      group('valid', ' #f00 '),
      group('invalid', 'red; display:none'),
      group('none', null)
    ]
    expect(getProjectGroupColors(rows, 'repo').map((entry) => entry?.color ?? null)).toEqual([
      '#ff0000',
      null,
      null
    ])
    expect(getProjectGroupColors(rows, 'none')).toEqual([])
    expect(getProjectGroupColors(rows, 'workspace-status')).toEqual([])
  })
})
