import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'
import { addHostSectionRows, type HostSectionRow } from './host-section-rows'

function repo(id: string): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0
  }
}

function item(id: string, project: Repo): Extract<Row, { type: 'item' }> {
  const worktree: Worktree = {
    id,
    repoId: project.id,
    path: `/${project.id}/${id}`,
    branch: id,
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

function repoHeader(project: Repo): Extract<Row, { type: 'header' }> {
  return {
    type: 'header',
    key: `repo:${project.id}`,
    label: project.displayName,
    count: 1,
    tone: 'text-foreground',
    repo: project
  }
}

function folderWorkspaceRow(args: {
  connectionId: string | null
  executionHostId?: string
}): Extract<Row, { type: 'folder-workspace' }> {
  const projectGroup: ProjectGroup = {
    id: 'group-1',
    name: 'Folder group',
    parentPath: '/srv/project',
    connectionId: args.connectionId,
    executionHostId: args.executionHostId,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const folderWorkspace: FolderWorkspace = {
    id: 'folder-1',
    projectGroupId: projectGroup.id,
    name: 'Folder workspace',
    folderPath: '/srv/project',
    connectionId: args.connectionId,
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
    sectionKey: 'all',
    folderWorkspace,
    projectGroup,
    depth: 0,
    groupDepth: 0
  }
}

function rowKey(row: HostSectionRow): string {
  return row.type === 'item' ? row.worktree.id : row.key
}

describe('folder workspace host sections', () => {
  it('includes a local folder workspace in the host count', () => {
    const local = repo('local')
    const ssh = { ...repo('ssh'), connectionId: 'ssh-1' }
    const sectioned = addHostSectionRows({
      rows: [
        repoHeader(local),
        item('local-wt', local),
        folderWorkspaceRow({ connectionId: null }),
        repoHeader(ssh),
        item('ssh-wt', ssh)
      ],
      hostOptions: [
        { id: 'local', kind: 'local', label: 'Local', detail: 'Local', health: 'local' },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'SSH', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(sectioned.map(rowKey)).toContain('folder-workspace:folder-1')
    expect(
      sectioned.find((row) => row.type === 'host-header' && row.hostId === 'local')
    ).toMatchObject({ count: 2 })
  })

  it.each([
    {
      connectionId: 'ssh-1',
      executionHostId: undefined,
      defaultHostId: 'local',
      defaultKind: 'local',
      targetHostId: 'ssh:ssh-1',
      targetKind: 'ssh'
    },
    {
      connectionId: null,
      executionHostId: 'runtime:env-2',
      defaultHostId: 'runtime:env-1',
      defaultKind: 'runtime',
      targetHostId: 'runtime:env-2',
      targetKind: 'runtime'
    }
  ] as const)('routes a folder workspace to $targetHostId', (testCase) => {
    const project = repo('project')
    const sectioned = addHostSectionRows({
      rows: [repoHeader(project), item('git-worktree', project), folderWorkspaceRow(testCase)],
      hostOptions: [
        {
          id: testCase.defaultHostId,
          kind: testCase.defaultKind,
          label: 'Default',
          detail: 'Default',
          health: testCase.defaultKind === 'local' ? 'local' : 'available'
        },
        {
          id: testCase.targetHostId,
          kind: testCase.targetKind,
          label: 'Target',
          detail: 'Target',
          health: 'available'
        }
      ],
      workspaceHostScope: 'all',
      defaultHostId: testCase.defaultHostId
    })

    expect(sectioned.map(rowKey)).toEqual([
      `host:${testCase.defaultHostId}`,
      'repo:project',
      'git-worktree',
      `host:${testCase.targetHostId}`,
      'folder-workspace:folder-1'
    ])
  })
})
