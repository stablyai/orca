import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import type { WorkspaceLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import type { WorktreeWithInlineLineage } from '../worktree/workspace-lineage-graph'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { cloneDefaultWorkspaceStatuses } from '../workspace-statuses'
import {
  folderWorkspaceToWorktree,
  getFolderWorkspaceWorktree
} from '../folder-workspaces/folder-workspace-worktree'
import { planSidebarRows } from './sidebar-row-plan'
import { resolveSidebarLineageParentIdentities } from './worktree-lineage-projection'
import type { Row, WorktreeGroupBy } from './row-types'

const group: ProjectGroup = {
  id: 'group-1',
  name: 'Multi repo',
  parentPath: '/work/multi',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}
const repo: Repo = {
  id: 'repo-1',
  path: '/work/multi/api',
  displayName: 'api',
  badgeColor: '#000000',
  addedAt: 0,
  projectGroupId: group.id
}
const folder: FolderWorkspace = {
  id: 'f-1',
  projectGroupId: group.id,
  name: 'Release',
  folderPath: '/work/multi',
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
const row = (id: string): Worktree => ({
  id,
  instanceId: `${id}#instance`,
  repoId: repo.id,
  path: `/work/multi/${id}`,
  branch: `refs/heads/${id}`,
  head: 'abc',
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
})
const nested = row('nested')
const other = row('other')
const folderRecord: WorkspaceLineage = {
  childWorkspaceKey: `worktree:${nested.id}`,
  childInstanceId: nested.instanceId,
  parentWorkspaceKey: 'folder:f-1',
  parentInstanceId: 'f-1',
  origin: 'manual',
  capture: { source: 'manual-action', confidence: 'explicit' },
  createdAt: 1
}

function plan(
  groupBy: WorktreeGroupBy,
  record: WorkspaceLineage | undefined,
  worktrees: Worktree[] = [nested, other],
  hidden: Worktree[] = [],
  repos: Repo[] = [repo],
  folders: FolderWorkspace[] = [folder],
  groups: ProjectGroup[] = [group]
): Row[] {
  const rows = new Map(
    [...worktrees, ...hidden, ...folders.map((entry) => getFolderWorkspaceWorktree(entry))].map(
      (entry) => [getWorktreeHostIdentity(entry), entry]
    )
  )
  return planSidebarRows({
    groupBy,
    sortBy: 'name',
    worktrees,
    repoMap: new Map(repos.map((entry) => [entry.id, entry])),
    prGroupOf: () => 'in-progress',
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    lineageParentIdentities: resolveSidebarLineageParentIdentities({}, rows, undefined, (entry) =>
      entry.id === nested.id ? record : undefined
    ),
    worktreeMap: new Map([...worktrees, ...hidden].map((entry) => [entry.id, entry])),
    nestLineage: true,
    projectGroups: groups,
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    pendingCreations: [],
    folderWorkspaces: folders,
    defaultHostId: 'local',
    hostLabelById: new Map([
      ['local', 'Local Mac'],
      ['runtime:env-1', 'windows 2']
    ]),
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: []
  }).render(new Set())
}

function shape(rows: Row[]): string[] {
  return rows.flatMap((entry) =>
    entry.type === 'header'
      ? [`header ${entry.label ?? entry.key} ${entry.count}`]
      : entry.type === 'folder-workspace'
        ? [`folder ${entry.folderWorkspace.name} children=${entry.lineageChildCount ?? 0}`]
        : entry.type === 'item'
          ? [`${'  '.repeat(entry.depth)}${entry.worktree.id}`]
          : []
  )
}

describe('folder workspaces as sidebar parents', () => {
  it('nests a folder child under the folder in its project group, header counts unchanged', () => {
    expect(shape(plan('repo', folderRecord))).toEqual([
      'header Multi repo 2',
      'folder Release children=1',
      '  nested',
      'header api 2',
      'other'
    ])
  })

  it('keeps a project whose only workspace sits under the folder, and its count', () => {
    expect(shape(plan('repo', folderRecord, [nested]))).toEqual([
      'header Multi repo 2',
      'folder Release children=1',
      '  nested',
      'header api 1'
    ])
  })

  it('leaves the child in its project when it has no folder parent', () => {
    expect(shape(plan('repo', undefined))).toEqual([
      'header Multi repo 2',
      'folder Release children=0',
      'header api 2',
      'nested',
      'other'
    ])
  })

  it('nests under the folder without grouping', () => {
    expect(shape(plan('none', folderRecord))).toEqual([
      'header all 3',
      'other',
      'folder Release children=1',
      '  nested'
    ])
  })

  it('nests by lane under status grouping, as worktree parents do', () => {
    const done = { ...nested, workspaceStatus: 'completed' }
    expect(shape(plan('workspace-status', folderRecord, [done, other]))).toEqual([
      'header In progress 2',
      'other',
      'folder Release children=0',
      'header Done 1',
      'nested'
    ])
  })

  it('groups a row under a hidden folder child by its own project', () => {
    const web: Repo = { ...repo, id: 'repo-2', path: '/work/multi/web', displayName: 'web' }
    const archived = { ...nested, isArchived: true }
    const grandchild: WorktreeWithInlineLineage = {
      ...row('grandchild'),
      repoId: web.id,
      lineage: {
        worktreeId: 'grandchild',
        worktreeInstanceId: 'grandchild#instance',
        parentWorktreeId: nested.id,
        parentWorktreeInstanceId: 'nested#instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    }
    expect(shape(plan('repo', folderRecord, [grandchild, other], [archived], [repo, web]))).toEqual(
      [
        'header Multi repo 3',
        'folder Release children=0',
        'header web 1',
        'grandchild',
        'header api 1',
        'other'
      ]
    )
  })

  it('ignores a record saved for an earlier workspace at the same path', () => {
    expect(shape(plan('none', { ...folderRecord, childInstanceId: 'old#instance' }))).toEqual([
      'header all 3',
      'nested',
      'other',
      'folder Release children=0'
    ])
  })

  it('names the machine on a folder card when workspaces span machines', () => {
    const remoteFolder = { ...folder, executionHostId: 'runtime:env-1' as const }
    const folderRow = plan('none', undefined, [other], [], [repo], [remoteFolder]).find(
      (entry) => entry.type === 'folder-workspace'
    )
    expect(folderRow?.type === 'folder-workspace' && folderRow.hostContextLabel).toBe('windows 2')
  })

  it('puts an unstamped folder card on its group machine, matching its label', () => {
    const remoteGroup = { ...group, executionHostId: 'runtime:env-1' }
    const folderRow = plan('none', undefined, [other], [], [repo], [folder], [remoteGroup]).find(
      (entry) => entry.type === 'folder-workspace'
    )
    expect(folderRow?.type === 'folder-workspace' && folderRow.hostContextLabel).toBe('windows 2')
    expect(
      folderRow?.type === 'folder-workspace' &&
        folderWorkspaceToWorktree(folderRow.folderWorkspace).hostId
    ).toBe('runtime:env-1')
  })
})
