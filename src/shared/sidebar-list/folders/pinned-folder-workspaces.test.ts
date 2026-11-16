import { expect, it } from 'vitest'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../../folder-workspaces/folder-workspace-host-routing.test-fixture'
import type { Worktree } from '../../worktree/types'
import type { Row } from '../row-types'
import { planSidebarRows, type SidebarRowPlanInputs } from '../sidebar-row-plan'

const group = makeProjectGroup({ id: 'personal', parentPath: '/workspace' })
const folder = makeFolderWorkspace({ id: 'device', projectGroupId: 'personal', isPinned: true })
const child: Worktree = {
  id: 'code',
  displayName: 'Original code',
  hostId: 'local',
  repoId: 'code-repo',
  path: '/workspace/code',
  branch: 'main',
  head: 'abc',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function render(overrides: Partial<SidebarRowPlanInputs> = {}, collapsed = new Set<string>()) {
  return planSidebarRows({
    groupBy: 'repo',
    sortBy: 'recent',
    worktrees: [],
    repoMap: new Map(),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: [],
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(),
    nestLineage: true,
    projectGroups: [group],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: [folder],
    defaultHostId: 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: [],
    ...overrides
  }).render(collapsed)
}

function outline(rows: Row[]) {
  return rows.flatMap((row) => {
    if (row.type === 'header') {
      return [[row.type, row.icon.kind, row.count]]
    }
    if (row.type === 'folder-workspace') {
      return [[row.type, row.folderWorkspace.id, row.depth]]
    }
    if (row.type === 'item') {
      return [[row.type, row.worktree.id, row.depth]]
    }
    return []
  })
}

const linkedChild: Partial<SidebarRowPlanInputs> = {
  worktrees: [child],
  worktreeMap: new Map([['code', child]]),
  repoMap: new Map([
    [
      'code-repo',
      { id: 'code-repo', displayName: 'Code', path: '/workspace/code', badgeColor: '', addedAt: 0 }
    ]
  ]),
  lineageParentIdentities: new Map([['local|code', 'local|folder:device']])
}

it('moves a pinned folder and its linked worktree to Pinned', () => {
  const rows = render(linkedChild)
  expect(outline(rows).slice(0, 3)).toEqual([
    ['header', 'pinned', 2],
    ['folder-workspace', 'device', 0],
    ['item', 'code', 1]
  ])
  expect(
    rows.filter((row) => row.type === 'folder-workspace').map((row) => row.folderWorkspace.id)
  ).toEqual(['device'])
})

it.each(['none', 'workspace-status', 'pr-status'] as const)(
  'shows a pinned folder-only workspace without an empty natural lane in %s grouping',
  (groupBy) => {
    expect(outline(render({ groupBy }))).toEqual([
      ['header', 'pinned', 1],
      ['folder-workspace', 'device', 0]
    ])
  }
)

it('also shows the folder in its group when that display option is enabled', () => {
  const rows = render({ ...linkedChild, pinnedDisplayPolicy: 'duplicate-in-groups' })
  expect(outline(rows).slice(0, 3)).toEqual([
    ['header', 'pinned', 2],
    ['folder-workspace', 'device', 0],
    ['item', 'code', 1]
  ])
  const folders = rows.filter((row) => row.type === 'folder-workspace')
  expect(folders.map((row) => row.folderWorkspace.id)).toEqual(['device', 'device'])
  expect(new Set(folders.map((row) => row.key)).size).toBe(2)
})

it('keeps same-id folders on other hosts in their own placement', () => {
  const rows = render({
    folderWorkspaces: [
      { ...folder, executionHostId: 'runtime:a' },
      { ...folder, executionHostId: 'runtime:b', isPinned: false }
    ]
  })
  expect(
    rows
      .filter((row) => row.type === 'folder-workspace')
      .map((row) => [row.folderWorkspace.executionHostId, row.folderWorkspace.isPinned])
  ).toEqual([
    ['runtime:a', true],
    ['runtime:b', false]
  ])
  expect(outline(rows).slice(0, 2)).toEqual([
    ['header', 'pinned', 1],
    ['folder-workspace', 'device', 0]
  ])
})

it('collapses a pinned folder together with its descendants', () => {
  const rows = render(linkedChild, new Set(['pinned']))
  expect(outline(rows).slice(0, 1)).toEqual([['header', 'pinned', 2]])
  expect(rows.filter((row) => row.type === 'folder-workspace' || row.type === 'item')).toEqual([])
})

it('moves an unpinned folder together with its pinned parent', () => {
  const parent = { ...child, isPinned: true }
  const rows = render({
    ...linkedChild,
    worktrees: [parent],
    worktreeMap: new Map([['code', parent]]),
    folderWorkspaces: [{ ...folder, isPinned: false }],
    lineageParentIdentities: new Map([['local|folder:device', 'local|code']])
  })
  expect(outline(rows).slice(0, 3)).toEqual([
    ['header', 'pinned', 2],
    ['item', 'code', 0],
    ['folder-workspace', 'device', 1]
  ])
  expect(
    rows.filter((row) => row.type === 'folder-workspace').map((row) => row.folderWorkspace.id)
  ).toEqual(['device'])
})
