import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows'
import { PINNED_GROUP_KEY } from './group-keys'
import type { Row, WorktreeGroupBy } from './row-types'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

const GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Folder Project',
  parentPath: '/tmp/parent',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: GROUP.id,
    name: 'Folder workspace',
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

const GROUPED_REPO: Repo = { ...repo, projectGroupId: GROUP.id }

function buildSidebarRows(options: {
  groupBy: WorktreeGroupBy
  folderWorkspaces?: readonly FolderWorkspace[]
  projectGroups?: readonly ProjectGroup[]
  worktrees?: (typeof worktree)[]
  collapsedGroups?: Set<string>
  showPinnedWorktreesInGroups?: boolean
}): Row[] {
  const worktrees = options.worktrees ?? [worktree]
  return buildRows(
    options.groupBy,
    worktrees,
    new Map([[GROUPED_REPO.id, GROUPED_REPO]]),
    null,
    options.collapsedGroups ?? new Set<string>(),
    undefined,
    undefined,
    'manual',
    {},
    new Map(worktrees.map((entry) => [entry.id, entry])),
    false,
    options.showPinnedWorktreesInGroups === true
      ? ({ showPinnedWorktreesInGroups: true } as never)
      : undefined,
    options.projectGroups ?? [GROUP],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    options.folderWorkspaces ?? [makeFolderWorkspace()]
  )
}

function folderRows(rows: Row[]): Extract<Row, { type: 'folder-workspace' }>[] {
  return rows.filter(
    (row): row is Extract<Row, { type: 'folder-workspace' }> => row.type === 'folder-workspace'
  )
}

function headerKeys(rows: Row[]): string[] {
  return rows.filter((row) => row.type === 'header').map((row) => row.key)
}

const ALL_GROUP_BY: WorktreeGroupBy[] = ['repo', 'workspace-status', 'pr-status', 'none']

describe('pinned folder workspaces land in the Pinned section', () => {
  // The screenshot case: Pin on a folder workspace flips isPinned, but the card
  // stayed under its project group instead of moving to the left Pinned list.
  for (const groupBy of ALL_GROUP_BY) {
    it(`emits the pinned folder workspace under Pinned when groupBy is ${groupBy}`, () => {
      const rows = buildSidebarRows({
        groupBy,
        folderWorkspaces: [makeFolderWorkspace({ isPinned: true })]
      })
      const pinnedHeaderIndex = rows.findIndex(
        (row) => row.type === 'header' && row.key === PINNED_GROUP_KEY
      )
      expect(pinnedHeaderIndex).toBeGreaterThanOrEqual(0)
      expect(rows[pinnedHeaderIndex]).toMatchObject({
        type: 'header',
        key: PINNED_GROUP_KEY,
        count: 1
      })
      expect(rows[pinnedHeaderIndex + 1]).toMatchObject({
        type: 'folder-workspace',
        key: `${PINNED_GROUP_KEY}:folder-workspace:fw-1`,
        sectionKey: PINNED_GROUP_KEY,
        folderWorkspace: { id: 'fw-1', isPinned: true }
      })
    })
  }

  it('creates Pinned when the only pinned member is a folder workspace', () => {
    const rows = buildSidebarRows({
      groupBy: 'repo',
      worktrees: [worktree],
      folderWorkspaces: [makeFolderWorkspace({ isPinned: true })]
    })
    expect(headerKeys(rows)[0]).toBe(PINNED_GROUP_KEY)
    expect(folderRows(rows)).toHaveLength(1)
  })

  it('keeps an unpinned folder workspace out of Pinned', () => {
    const rows = buildSidebarRows({
      groupBy: 'repo',
      folderWorkspaces: [makeFolderWorkspace({ isPinned: false })]
    })
    expect(headerKeys(rows)).not.toContain(PINNED_GROUP_KEY)
    expect(folderRows(rows)).toHaveLength(1)
  })
})

describe('pinned folder workspaces follow the display policy', () => {
  it('leaves the project group in single-location mode', () => {
    const rows = buildSidebarRows({
      groupBy: 'repo',
      folderWorkspaces: [makeFolderWorkspace({ isPinned: true })]
    })
    expect(folderRows(rows)).toHaveLength(1)
    const projectHeaderIndex = rows.findIndex(
      (row) => row.type === 'header' && row.key.startsWith('project-group:')
    )
    expect(projectHeaderIndex).toBeGreaterThan(0)
    const afterProject = rows.slice(projectHeaderIndex + 1)
    expect(folderRows(afterProject)).toHaveLength(0)
  })

  it('duplicates into the project group when the policy allows it', () => {
    const rows = buildSidebarRows({
      groupBy: 'repo',
      folderWorkspaces: [makeFolderWorkspace({ isPinned: true })],
      showPinnedWorktreesInGroups: true
    })
    expect(folderRows(rows)).toHaveLength(2)
    expect(rows[0]).toMatchObject({ type: 'header', key: PINNED_GROUP_KEY })
    expect(rows[1]).toMatchObject({
      type: 'folder-workspace',
      key: `${PINNED_GROUP_KEY}:folder-workspace:fw-1`,
      sectionKey: PINNED_GROUP_KEY,
      folderWorkspace: { id: 'fw-1' }
    })
    expect(folderRows(rows.slice(2)).map((row) => row.sectionKey)).toEqual([
      `project-group:${GROUP.id}`
    ])
  })

  it('sits beside a pinned git worktree in Pinned', () => {
    const pinnedWorktree = { ...worktree, id: 'wt-pinned', isPinned: true }
    const rows = buildSidebarRows({
      groupBy: 'none',
      worktrees: [pinnedWorktree],
      folderWorkspaces: [makeFolderWorkspace({ isPinned: true })]
    })
    expect(rows[0]).toMatchObject({ type: 'header', key: PINNED_GROUP_KEY, count: 2 })
    expect(rows[1]).toMatchObject({ type: 'item', worktree: { id: 'wt-pinned' } })
    expect(rows[2]).toMatchObject({ type: 'folder-workspace', folderWorkspace: { id: 'fw-1' } })
  })
})

describe('pinned folder workspace host bookkeeping', () => {
  const SSH_HOST = 'ssh:target-1' as ExecutionHostId

  it('scopes a folder-only Pinned header to its host', () => {
    const sshGroup: ProjectGroup = { ...GROUP, connectionId: 'target-1' }
    const rows = buildRows(
      'repo',
      [],
      new Map(),
      null,
      new Set(),
      undefined,
      undefined,
      'manual',
      {},
      new Map(),
      false,
      undefined,
      [sshGroup],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [makeFolderWorkspace({ isPinned: true })]
    )
    const header = rows.find((row) => row.type === 'header' && row.key === PINNED_GROUP_KEY)
    expect(header).toBeDefined()
    const counts = header && 'hostWorktreeCounts' in header ? header.hostWorktreeCounts : undefined
    expect(counts?.get(SSH_HOST)).toBe(1)
    const ids = header && 'hostWorktreeIds' in header ? header.hostWorktreeIds : undefined
    expect(ids?.has(SSH_HOST)).toBe(true)
    expect(ids?.get(SSH_HOST)).toEqual([])
  })
})
