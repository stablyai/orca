import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows'
import { getFolderWorkspaceLaneKey } from './folder-workspace-lanes'
import {
  getFolderWorkspaceAttachedGroupKey,
  getPRGroupKey,
  getPRLaneKey,
  PINNED_GROUP_KEY
} from './group-keys'
import type { Row, WorktreeGroupBy } from './row-types'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorkspaceLineage } from '../../../../../../shared/worktree/lineage-types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../../../shared/workspace-scope'

const GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Multi-repo Group',
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
  workspaceLineageByChildKey?: Record<string, WorkspaceLineage>
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
    undefined,
    options.projectGroups ?? [GROUP],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    options.folderWorkspaces ?? [makeFolderWorkspace()],
    undefined,
    undefined,
    undefined,
    options.workspaceLineageByChildKey ?? {}
  )
}

function attachedTo(folderWorkspaceId: string, worktreeId: string): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(worktreeId),
    parentWorkspaceKey: folderWorkspaceKey(folderWorkspaceId),
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

function itemRows(rows: Row[]): Extract<Row, { type: 'item' }>[] {
  return rows.filter((row): row is Extract<Row, { type: 'item' }> => row.type === 'item')
}

function folderRows(rows: Row[]): Extract<Row, { type: 'folder-workspace' }>[] {
  return rows.filter(
    (row): row is Extract<Row, { type: 'folder-workspace' }> => row.type === 'folder-workspace'
  )
}

const ALL_GROUP_BY: WorktreeGroupBy[] = ['repo', 'workspace-status', 'pr-status', 'none']

describe('folder workspaces render under every Group by mode', () => {
  // The three non-repo arms are the acceptance evidence; the repo arm is a
  // deliberate no-regression guard that also passed before the fix.
  for (const groupBy of ALL_GROUP_BY) {
    it(`emits the folder-workspace row when groupBy is ${groupBy}`, () => {
      expect(folderRows(buildSidebarRows({ groupBy }))).toHaveLength(1)
    })
  }

  it('does not duplicate the row under repo grouping', () => {
    const rows = buildSidebarRows({ groupBy: 'repo' })
    expect(folderRows(rows).map((row) => row.key)).toEqual(['folder-workspace:fw-1'])
  })
})

describe('worktrees attached to a folder workspace', () => {
  // The child's own status would put it in the todo lane; attachment wins.
  const attachedChild = { ...worktree, workspaceStatus: 'todo' as const }
  const lineage = { [worktreeWorkspaceKey(worktree.id)]: attachedTo('fw-1', worktree.id) }

  for (const groupBy of ALL_GROUP_BY) {
    it(`nests the child beneath its folder workspace when groupBy is ${groupBy}`, () => {
      const rows = buildSidebarRows({
        groupBy,
        worktrees: [attachedChild],
        workspaceLineageByChildKey: lineage
      })

      const [folderRow] = folderRows(rows)
      const [childRow, ...otherItems] = itemRows(rows)
      expect(otherItems).toHaveLength(0)
      expect(folderRow).toMatchObject({
        attachedChildCount: 1,
        attachedGroupKey: getFolderWorkspaceAttachedGroupKey('fw-1'),
        attachedCollapsed: false
      })
      expect(rows.indexOf(childRow)).toBe(rows.indexOf(folderRow) + 1)
      expect(childRow).toMatchObject({
        worktree: attachedChild,
        sectionKey: folderWorkspaceKey('fw-1'),
        depth: 1
      })
      expect(rows.some((row) => row.type === 'header' && row.key === 'workspace-status:todo')).toBe(
        false
      )
    })
  }

  it('hides the children while the attached group is collapsed', () => {
    const rows = buildSidebarRows({
      groupBy: 'workspace-status',
      worktrees: [attachedChild],
      workspaceLineageByChildKey: lineage,
      collapsedGroups: new Set([getFolderWorkspaceAttachedGroupKey('fw-1')])
    })

    expect(itemRows(rows)).toHaveLength(0)
    expect(folderRows(rows)[0]).toMatchObject({ attachedChildCount: 1, attachedCollapsed: true })
  })

  it('keeps a pinned child in the pinned section, matching worktree lineage', () => {
    const rows = buildSidebarRows({
      groupBy: 'workspace-status',
      worktrees: [{ ...attachedChild, isPinned: true }],
      workspaceLineageByChildKey: lineage
    })

    expect(itemRows(rows).map((row) => row.sectionKey)).toEqual([PINNED_GROUP_KEY])
    expect(folderRows(rows)[0]).toMatchObject({ attachedChildCount: 0 })
  })

  it('leaves the child in its own lane when the folder workspace is not rendered', () => {
    // Why: a host filter that hides the folder must not also hide its children.
    const rows = buildSidebarRows({
      groupBy: 'workspace-status',
      worktrees: [attachedChild],
      workspaceLineageByChildKey: lineage,
      folderWorkspaces: []
    })

    expect(itemRows(rows).map((row) => row.sectionKey)).toEqual(['workspace-status:todo'])
  })

  it('ignores lineage whose child instance no longer matches', () => {
    const staleLineage = {
      [worktreeWorkspaceKey(worktree.id)]: {
        ...attachedTo('fw-1', worktree.id),
        childInstanceId: 'instance-from-a-previous-checkout'
      }
    }
    const rows = buildSidebarRows({
      groupBy: 'workspace-status',
      worktrees: [{ ...attachedChild, instanceId: 'current-instance' }],
      workspaceLineageByChildKey: staleLineage
    })

    expect(itemRows(rows).map((row) => row.sectionKey)).toEqual(['workspace-status:todo'])
    expect(folderRows(rows)[0]).toMatchObject({ attachedChildCount: 0 })
  })
})

describe('a folder workspace can be the only member of a lane', () => {
  it('creates its status lane with no worktrees present', () => {
    const rows = buildSidebarRows({ groupBy: 'workspace-status', worktrees: [] })
    expect(folderRows(rows)).toHaveLength(1)
    const header = rows.find((row) => row.type === 'header')
    expect(header).toBeDefined()
    expect(header && 'count' in header ? header.count : null).toBe(1)
  })

  it('renders in flat mode with no worktrees present', () => {
    // Pre-fix the whole All section was gated on naturalWorktrees.length > 0,
    // so a folder-only account saw nothing at all.
    const rows = buildSidebarRows({ groupBy: 'none', worktrees: [] })
    expect(folderRows(rows)).toHaveLength(1)
  })
})

describe('lane assignment', () => {
  it('routes to the same PR lane as a worktree with no PR', () => {
    const laneKey = getFolderWorkspaceLaneKey(
      { folderWorkspace: makeFolderWorkspace(), projectGroup: GROUP },
      'pr-status',
      []
    )
    const noPrWorktreeLane = getPRLaneKey(
      getPRGroupKey(worktree, new Map([[GROUPED_REPO.id, GROUPED_REPO]]), null)
    )
    expect(laneKey).toBe(noPrWorktreeLane)
  })
})

describe('ordering', () => {
  const ordered = [
    makeFolderWorkspace({ id: 'fw-low', name: 'Low', sortOrder: 1 }),
    makeFolderWorkspace({ id: 'fw-high', name: 'High', sortOrder: 9 })
  ]

  // Both emitters are covered: grouped lanes and the separate flat-mode path.
  for (const groupBy of ['workspace-status', 'none'] as WorktreeGroupBy[]) {
    it(`orders by manualOrder then sortOrder under ${groupBy}`, () => {
      const rows = buildSidebarRows({ groupBy, folderWorkspaces: ordered })
      expect(folderRows(rows).map((row) => row.folderWorkspace.id)).toEqual(['fw-high', 'fw-low'])
    })

    it(`prefers manualOrder over sortOrder under ${groupBy}`, () => {
      const rows = buildSidebarRows({
        groupBy,
        folderWorkspaces: [
          makeFolderWorkspace({ id: 'fw-low', name: 'Low', sortOrder: 9, manualOrder: 1 }),
          makeFolderWorkspace({ id: 'fw-high', name: 'High', sortOrder: 1, manualOrder: 9 })
        ]
      })
      expect(folderRows(rows).map((row) => row.folderWorkspace.id)).toEqual(['fw-high', 'fw-low'])
    })
  }
})

describe('membership is decided once, not per mode', () => {
  // Negative arm alone is vacuous (zero rows either way pre-fix), so it is
  // paired with an explicitly non-repo positive arm.
  it('renders nothing when the owning project group is not visible', () => {
    const rows = buildSidebarRows({ groupBy: 'workspace-status', projectGroups: [] })
    expect(folderRows(rows)).toHaveLength(0)
  })

  it('renders under a non-repo mode when the owning group is visible', () => {
    const rows = buildSidebarRows({ groupBy: 'workspace-status' })
    expect(folderRows(rows)).toHaveLength(1)
  })

  it('keeps archived folder workspaces behaving identically in every mode', () => {
    const archived = [makeFolderWorkspace({ isArchived: true })]
    const counts = ALL_GROUP_BY.map(
      (groupBy) => folderRows(buildSidebarRows({ groupBy, folderWorkspaces: archived })).length
    )
    // Parity with today's behaviour: nothing filters folder workspaces by
    // isArchived, so a mode must not be the thing that hides one.
    expect(counts).toEqual([1, 1, 1, 1])
  })
})

describe('host bookkeeping for lanes containing folder workspaces', () => {
  const SSH_HOST = 'ssh:target-1' as ExecutionHostId

  it('scopes a collapsed folder-only lane header to its host', () => {
    const sshGroup: ProjectGroup = { ...GROUP, connectionId: 'target-1' }
    const rows = buildRows(
      'workspace-status',
      [],
      new Map(),
      null,
      new Set(['workspace-status:in-progress']),
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
      [makeFolderWorkspace()]
    )
    const header = rows.find((row) => row.type === 'header')
    expect(header).toBeDefined()
    const counts = header && 'hostWorktreeCounts' in header ? header.hostWorktreeCounts : undefined
    // Undefined counts render globally, which is exactly the pre-fix bug.
    expect(counts).toBeDefined()
    expect(counts?.get(SSH_HOST)).toBe(1)
  })

  it('gives a folder-only host an explicit empty id array', () => {
    const sshGroup: ProjectGroup = { ...GROUP, connectionId: 'target-1' }
    const rows = buildRows(
      'workspace-status',
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
      [makeFolderWorkspace()]
    )
    const header = rows.find((row) => row.type === 'header')
    const ids = header && 'hostWorktreeIds' in header ? header.hostWorktreeIds : undefined
    // The key must exist even though folder workspaces contribute no worktree
    // ids, or the host-section fallback leaks the global id list into it.
    expect(ids?.has(SSH_HOST)).toBe(true)
    expect(ids?.get(SSH_HOST)).toEqual([])
  })
})
