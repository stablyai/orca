import { describe, expect, it } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import type { Row } from './worktree-list-groups'
import { addHostSectionRows, type HostSectionRow } from './host-section-rows'

function repo(id: string, connectionId?: string | null): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId
  }
}

function worktree(id: string, repoId: string): Worktree {
  return {
    id,
    repoId,
    path: `/${repoId}/${id}`,
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
}

function header(key: string, label = key): Extract<Row, { type: 'header' }> {
  return {
    type: 'header',
    key,
    label,
    count: 1,
    tone: 'text-foreground'
  }
}

function repoHeader(project: Repo): Extract<Row, { type: 'header' }> {
  return {
    ...header(`repo:${project.id}`, project.displayName),
    repo: project
  }
}

function item(id: string, project: Repo): Extract<Row, { type: 'item' }> {
  return {
    type: 'item',
    worktree: worktree(id, project.id),
    repo: project,
    depth: 0,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}

function folderWorkspaceRow(
  connectionId: string | null
): Extract<Row, { type: 'folder-workspace' }> {
  const projectGroup: ProjectGroup = {
    id: 'group-1',
    name: 'Remote folder',
    parentPath: '/srv/project',
    connectionId,
    parentGroupId: null,
    createdFrom: 'manual',
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
    connectionId,
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
    projectGroup,
    depth: 0,
    groupDepth: 0
  }
}

function rowKey(row: HostSectionRow): string {
  return row.type === 'item' ? row.worktree.id : row.key
}

describe('addHostSectionRows', () => {
  it('does not add host headers for a specific host scope', () => {
    const local = repo('local')
    const rows = [repoHeader(local), item('local-wt', local)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'local',
      defaultHostId: 'local'
    })

    expect(sectioned).toHaveLength(2)
    expect(sectioned).toEqual(rows)
  })

  it('does not add host headers when only the local host exists', () => {
    const local = repo('local')
    const rows = [repoHeader(local), item('local-wt', local)]

    expect(
      addHostSectionRows({
        rows,
        hostOptions: [
          {
            id: 'local',
            kind: 'local',
            label: 'Local Mac',
            detail: 'This computer',
            health: 'local'
          }
        ],
        workspaceHostScope: 'all',
        defaultHostId: 'local'
      })
    ).toEqual(rows)
  })

  it('groups rows under host headers in all-host scope', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    const rows = [repoHeader(local), item('local-wt', local), repoHeader(ssh), item('ssh-wt', ssh)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:local',
      'repo:local',
      'local-wt',
      'host:ssh:ssh-1',
      'repo:ssh',
      'ssh-wt'
    ])
    expect(sectioned.filter((row) => row.type === 'host-header')).toMatchObject([
      { label: 'Local Mac', count: 1 },
      { label: 'Builder', count: 1 }
    ])
  })

  it('keeps project grouping outermost in the default Projects view', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    const rows = [repoHeader(local), item('local-wt', local), repoHeader(ssh), item('ssh-wt', ssh)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      preferProjectGrouping: true
    })

    expect(sectioned).toEqual(rows)
  })

  it('keeps host headers for a custom multi-host visibility filter', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    const rows = [repoHeader(local), item('local-wt', local), repoHeader(ssh), item('ssh-wt', ssh)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      visibleWorkspaceHostIds: ['local', 'ssh:ssh-1'],
      defaultHostId: 'local',
      preferProjectGrouping: true
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:local',
      'repo:local',
      'local-wt',
      'host:ssh:ssh-1',
      'repo:ssh',
      'ssh-wt'
    ])
  })

  it('keeps non-repo group headers with the following host-owned rows', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    const rows = [header('all'), item('local-wt', local), header('done'), item('ssh-wt', ssh)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:local',
      'all',
      'local-wt',
      'host:ssh:ssh-1',
      'done',
      'ssh-wt'
    ])
  })

  it('groups explicitly runtime-owned repos under their owner host, not the focused host', () => {
    const localOwned: Repo = { ...repo('local-project'), executionHostId: 'local' }
    const runtimeOwned: Repo = { ...repo('remote-project'), executionHostId: 'runtime:env-2' }
    const rows = [
      repoHeader(localOwned),
      item('local-wt', localOwned),
      repoHeader(runtimeOwned),
      item('remote-wt', runtimeOwned)
    ]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        {
          id: 'runtime:env-1',
          kind: 'runtime',
          label: 'env-1',
          detail: 'Orca server',
          health: 'available'
        },
        {
          id: 'runtime:env-2',
          kind: 'runtime',
          label: 'env-2',
          detail: 'Orca server',
          health: 'available'
        }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:env-1'
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:local',
      'repo:local-project',
      'local-wt',
      'host:runtime:env-2',
      'repo:remote-project',
      'remote-wt'
    ])
  })

  it('groups SSH folder workspace rows under their connection host', () => {
    const local = repo('local')
    const rows: Row[] = [repoHeader(local), item('local-wt', local), folderWorkspaceRow('ssh-1')]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:local',
      'repo:local',
      'local-wt',
      'host:ssh:ssh-1',
      'folder-workspace:folder-1'
    ])
  })

  it('carries the SSH connection status through to the host header row', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    const rows = [repoHeader(local), item('local-wt', local), repoHeader(ssh), item('ssh-wt', ssh)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        {
          id: 'ssh:ssh-1',
          kind: 'ssh',
          label: 'Builder',
          detail: 'SSH',
          health: 'error',
          connectionStatus: 'auth-failed'
        }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(
      sectioned.find((row) => row.type === 'host-header' && row.hostId === 'ssh:ssh-1')
    ).toMatchObject({
      health: 'error',
      connectionStatus: 'auth-failed',
      collapsed: false
    })
  })

  it('uses the focused runtime as the owner for non-SSH repos', () => {
    const localOwned: Repo = { ...repo('local-project'), executionHostId: 'local' }
    const project = repo('runtime-project')
    const rows = [
      repoHeader(localOwned),
      item('local-wt', localOwned),
      repoHeader(project),
      item('runtime-wt', project)
    ]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        {
          id: 'runtime:env-1',
          kind: 'runtime',
          label: 'env-1',
          detail: 'Orca server',
          health: 'available'
        }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:env-1'
    })

    expect(
      sectioned.find((row) => row.type === 'host-header' && row.hostId === 'runtime:env-1')
    ).toMatchObject({
      key: 'host:runtime:env-1',
      label: 'env-1'
    })
  })

  it('passes host kind and blocked compatibility through to the header row', () => {
    const localOwned: Repo = { ...repo('local-project'), executionHostId: 'local' }
    const project = repo('runtime-project')
    const rows = [
      repoHeader(localOwned),
      item('local-wt', localOwned),
      repoHeader(project),
      item('runtime-wt', project)
    ]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        {
          id: 'runtime:env-1',
          kind: 'runtime',
          label: 'env-1',
          detail: 'Orca server',
          health: 'blocked',
          compatibility: {
            kind: 'blocked',
            reason: 'server-too-old',
            clientProtocolVersion: 5,
            serverProtocolVersion: 1,
            requiredServerProtocolVersion: 4
          }
        }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'runtime:env-1'
    })

    expect(
      sectioned.find((row) => row.type === 'host-header' && row.hostId === 'runtime:env-1')
    ).toMatchObject({
      kind: 'runtime',
      health: 'blocked',
      compatibility: { kind: 'blocked', reason: 'server-too-old' }
    })
  })

  it('suppresses host headers when only one host has visible workspaces', () => {
    const local = repo('local')
    const rows = [repoHeader(local), item('local-wt', local)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'disconnected' },
        {
          id: 'runtime:env-1',
          kind: 'runtime',
          label: 'env-1',
          detail: 'Orca server',
          health: 'available'
        }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(sectioned).toEqual(rows)
  })

  it('counts a collapsed repo group via its header count instead of zero', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    // The ssh repo group is collapsed: its header is present, items are not.
    const collapsedSshHeader = { ...repoHeader(ssh), count: 9 }
    const rows = [repoHeader(local), item('local-wt', local), collapsedSshHeader]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(
      sectioned.find((row) => row.type === 'host-header' && row.hostId === 'ssh:ssh-1')
    ).toMatchObject({ count: 9 })
    expect(
      sectioned.find((row) => row.type === 'host-header' && row.hostId === 'local')
    ).toMatchObject({ count: 1 })
  })

  it('keeps a collapsed host header but hides its rows', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    const rows = [repoHeader(local), item('local-wt', local), repoHeader(ssh), item('ssh-wt', ssh)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      collapsedHostKeys: new Set(['host:ssh:ssh-1'])
    })

    expect(sectioned.map(rowKey)).toEqual([
      'host:local',
      'repo:local',
      'local-wt',
      'host:ssh:ssh-1'
    ])
    expect(sectioned.filter((row) => row.type === 'host-header')).toMatchObject([
      { hostId: 'local', collapsed: false },
      { hostId: 'ssh:ssh-1', collapsed: true, count: 1 }
    ])
  })

  it('can temporarily collapse every host without mutating persisted collapse keys', () => {
    const local = repo('local')
    const ssh = repo('ssh', 'ssh-1')
    const rows = [repoHeader(local), item('local-wt', local), repoHeader(ssh), item('ssh-wt', ssh)]

    const sectioned = addHostSectionRows({
      rows,
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      collapsedHostKeys: new Set(),
      forceCollapseHosts: true
    })

    expect(sectioned.map(rowKey)).toEqual(['host:local', 'host:ssh:ssh-1'])
    expect(sectioned.filter((row) => row.type === 'host-header')).toMatchObject([
      { hostId: 'local', collapsed: true, count: 1 },
      { hostId: 'ssh:ssh-1', collapsed: true, count: 1 }
    ])
  })
})
