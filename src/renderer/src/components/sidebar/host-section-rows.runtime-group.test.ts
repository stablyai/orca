import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'
import type { Row } from './worktree-list/grouping/row-types'

const FOCUSED: ExecutionHostId = 'runtime:env-1'
const OWNER: ExecutionHostId = 'runtime:env-2'

function repo(id: string, executionHostId: ExecutionHostId): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: null,
    executionHostId
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
    rowKey: `repo:${project.id}:${id}`,
    sectionKey: `repo:${project.id}`,
    worktree,
    repo: project,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}

function projectGroup(
  executionHostId: ExecutionHostId | null,
  connectionId: string | null
): ProjectGroup {
  return {
    id: 'group-a',
    name: 'Server group',
    parentPath: '/srv/project',
    connectionId,
    executionHostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function groupHeader(group: ProjectGroup): Extract<Row, { type: 'header' }> {
  return {
    type: 'header',
    key: `group:${group.id}`,
    label: group.name,
    count: 1,
    tone: 'text-foreground',
    projectGroup: group
  }
}

function folderRow(group: ProjectGroup): Extract<Row, { type: 'folder-workspace' }> {
  const folderWorkspace: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: group.id,
    name: 'Folder workspace',
    folderPath: '/srv/project',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  return {
    type: 'folder-workspace',
    key: 'folder-workspace:folder-1',
    folderWorkspace,
    projectGroup: group,
    depth: 0,
    groupDepth: 0
  }
}

const hostOptions: HostSectionOption[] = [
  { id: FOCUSED, kind: 'runtime', label: 'env-1', detail: 'Orca server', health: 'available' },
  { id: OWNER, kind: 'runtime', label: 'env-2', detail: 'Orca server', health: 'available' }
]

function sectioned(rows: Row[]) {
  return addHostSectionRows({
    rows,
    hostOptions,
    workspaceHostScope: 'all',
    defaultHostId: FOCUSED
  })
}

function renderedHostFilter(rows: Row[]) {
  return addHostSectionRows({
    rows,
    hostOptions,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: [FOCUSED, OWNER],
    defaultHostId: FOCUSED,
    preferProjectGrouping: true
  })
}

function rowKey(row: { type: string; key?: string; worktree?: { id: string } }): string {
  return row.type === 'item' ? row.worktree!.id : (row.key ?? row.type)
}

describe('runtime-stamped project groups', () => {
  it('keeps a connectionless runtime group under its owner when another server is focused', () => {
    const focusedRepo = repo('focused-project', FOCUSED)
    const ownerRepo = repo('owner-project', OWNER)
    const rows = sectioned([
      groupHeader(projectGroup(OWNER, null)),
      item('focused-wt', focusedRepo),
      item('owner-wt', ownerRepo)
    ])

    expect(rows.map(rowKey)).toEqual([
      'host:runtime:env-1',
      'focused-wt',
      'host:runtime:env-2',
      'group:group-a',
      'owner-wt'
    ])
  })

  it('places a connectionless folder workspace under the stamped group host', () => {
    const focusedRepo = repo('focused-project', FOCUSED)
    const rows = sectioned([item('focused-wt', focusedRepo), folderRow(projectGroup(OWNER, null))])

    expect(rows.map(rowKey)).toEqual([
      'host:runtime:env-1',
      'focused-wt',
      'host:runtime:env-2',
      'folder-workspace:folder-1'
    ])
  })

  it('keeps an unstamped project group header buffered across host runs', () => {
    const rows = sectioned([
      groupHeader(projectGroup(null, null)),
      item('owner-wt', repo('owner-project', OWNER)),
      item('focused-wt', repo('focused-project', FOCUSED))
    ])

    expect(rows.map(rowKey)).toEqual([
      'host:runtime:env-1',
      'group:group-a',
      'focused-wt',
      'host:runtime:env-2',
      'group:group-a',
      'owner-wt'
    ])
  })

  it('keeps a runtime-stamped group under its owner when the sidebar filters to both hosts', () => {
    const rows = renderedHostFilter([
      groupHeader(projectGroup(OWNER, null)),
      item('owner-wt', repo('owner-project', OWNER)),
      item('focused-wt', repo('focused-project', FOCUSED))
    ])

    expect(rows.map(rowKey)).toEqual([
      'host:runtime:env-1',
      'focused-wt',
      'host:runtime:env-2',
      'group:group-a',
      'owner-wt'
    ])
  })

  it('does not add host headers in the unfiltered projects view', () => {
    const rows = addHostSectionRows({
      rows: [
        groupHeader(projectGroup(OWNER, null)),
        item('owner-wt', repo('owner-project', OWNER))
      ],
      hostOptions,
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: null,
      defaultHostId: FOCUSED,
      preferProjectGrouping: true
    })

    expect(rows.map(rowKey)).toEqual(['group:group-a', 'owner-wt'])
  })
})
