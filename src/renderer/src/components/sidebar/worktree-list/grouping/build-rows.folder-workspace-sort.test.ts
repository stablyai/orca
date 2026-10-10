import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows'
import { buildFolderWorkspaceComparator } from './folder-workspace-lanes'
import type { Row, WorktreeGroupBy } from './row-types'
import type { SortBy } from '../../smart-sort'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'

const GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Scanned folder',
  parentPath: '/tmp/parent',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const GROUPED_REPO: Repo = { ...repo, projectGroupId: GROUP.id }

function makeFolderWorkspace(
  name: string,
  overrides: Partial<FolderWorkspace> = {}
): FolderWorkspace {
  return {
    id: `fw-${name}`,
    projectGroupId: GROUP.id,
    name,
    folderPath: '/tmp/parent',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    workspaceStatus: 'in-progress',
    ...overrides
  }
}

// Created in the order 2_, 1_, 3_ so creation order differs from name and activity order.
const FOLDER_WORKSPACES = [
  makeFolderWorkspace('2_settlement', { sortOrder: 100, createdAt: 100, lastActivityAt: 300 }),
  makeFolderWorkspace('1_benefit', { sortOrder: 200, createdAt: 200, lastActivityAt: 100 }),
  makeFolderWorkspace('3_app', { sortOrder: 300, createdAt: 300, lastActivityAt: 200 })
]

function folderWorkspaceNames(groupBy: WorktreeGroupBy, sortBy: SortBy): string[] {
  const rows: Row[] = buildRows(
    groupBy,
    [worktree],
    new Map([[GROUPED_REPO.id, GROUPED_REPO]]),
    null,
    new Set<string>(),
    undefined,
    undefined,
    'manual',
    {},
    new Map([[worktree.id, worktree]]),
    false,
    undefined,
    [GROUP],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    FOLDER_WORKSPACES,
    undefined,
    undefined,
    undefined,
    sortBy
  )
  return rows.flatMap((row) => (row.type === 'folder-workspace' ? [row.folderWorkspace.name] : []))
}

describe('folder workspace order follows the sidebar Sort by mode', () => {
  for (const groupBy of ['repo', 'none', 'workspace-status'] as const) {
    describe(`group by ${groupBy}`, () => {
      it('Name sorts by name', () => {
        expect(folderWorkspaceNames(groupBy, 'name')).toEqual([
          '1_benefit',
          '2_settlement',
          '3_app'
        ])
      })

      it('Recent sorts by last activity, newest first', () => {
        expect(folderWorkspaceNames(groupBy, 'recent')).toEqual([
          '2_settlement',
          '3_app',
          '1_benefit'
        ])
      })

      it('Manual keeps the user-authored order, falling back to creation order', () => {
        expect(folderWorkspaceNames(groupBy, 'manual')).toEqual([
          '3_app',
          '1_benefit',
          '2_settlement'
        ])
      })
    })
  }
})

describe('buildFolderWorkspaceComparator', () => {
  it('Repo sorts by name because folder workspaces have no repo', () => {
    const sorted = [...FOLDER_WORKSPACES].sort(buildFolderWorkspaceComparator('repo', 1_000))
    expect(sorted.map((entry) => entry.name)).toEqual(['1_benefit', '2_settlement', '3_app'])
  })

  it('Smart falls back to recency because folder workspaces carry no agent attention', () => {
    const sorted = [...FOLDER_WORKSPACES].sort(buildFolderWorkspaceComparator('smart', 1_000_000))
    expect(sorted.map((entry) => entry.name)).toEqual(['2_settlement', '3_app', '1_benefit'])
  })

  it('Manual prefers manualOrder over creation order', () => {
    const withManual = [
      ...FOLDER_WORKSPACES.slice(0, 2),
      { ...FOLDER_WORKSPACES[2]!, manualOrder: 1 }
    ]
    const sorted = withManual.sort(buildFolderWorkspaceComparator('manual', 1_000))
    expect(sorted.map((entry) => entry.name)).toEqual(['1_benefit', '2_settlement', '3_app'])
  })
})
