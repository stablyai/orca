import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientTarget } from '../runtime/runtime-client-target'
import { adoptFromEndpoint } from './adopt-from-endpoint'
import { getFolderWorkspaceHostId } from './folder-workspaces/folder-workspace-catalog'

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const SERVER: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-a' }

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/srv/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

function group(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'group',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function setup(overrides: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: 'setup-1',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/srv/repo',
    displayName: 'repo',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function workspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'group-1',
    name: 'folder',
    folderPath: '/srv/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1,
    lastActivityAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('adoptFromEndpoint', () => {
  describe('repo', () => {
    it.each([
      ['local row', LOCAL, repo(), 'local'],
      [
        'local row keeping an existing stamp',
        LOCAL,
        repo({ executionHostId: 'ssh:kept' }),
        'ssh:kept'
      ],
      ['direct SSH row', LOCAL, repo({ connectionId: 'conn-1' }), 'ssh:conn-1'],
      ['server row', SERVER, repo(), 'runtime:env-a'],
      ['server row naming a host', SERVER, repo({ executionHostId: 'local' }), 'runtime:env-a']
    ])('%s', (_name, target, row, expectedHostId) => {
      const adopted = adoptFromEndpoint(target, { kind: 'repo', row })
      expect(adopted.executionHostId).toBe(expectedHostId)
    })

    it('keeps a server row nested SSH target', () => {
      const adopted = adoptFromEndpoint(SERVER, {
        kind: 'repo',
        row: repo({ connectionId: 'nested' })
      })
      expect(adopted).toMatchObject({ executionHostId: 'runtime:env-a', connectionId: 'nested' })
    })
  })

  describe('projectGroup', () => {
    it.each([
      ['local row', LOCAL, group(), 'local'],
      [
        'local row overwrites a stale stamp',
        LOCAL,
        group({ executionHostId: 'runtime:old' }),
        'local'
      ],
      ['SSH row', LOCAL, group({ connectionId: 'conn-1' }), 'ssh:conn-1'],
      ['server row', SERVER, group({ connectionId: 'nested' }), 'runtime:env-a']
    ])('%s', (_name, target, row, expectedHostId) => {
      const adopted = adoptFromEndpoint(target, { kind: 'projectGroup', row })
      expect(adopted.executionHostId).toBe(expectedHostId)
    })
  })

  describe('projectHostSetup', () => {
    it('leaves a local row as the host published it', () => {
      const row = setup({ hostId: 'ssh:conn-1', connectionId: 'conn-1' })
      expect(adoptFromEndpoint(LOCAL, { kind: 'projectHostSetup', row })).toEqual(row)
    })

    it.each([
      ['server-local row', setup(), 'runtime:env-a'],
      ['server row naming its SSH target', setup({ hostId: 'ssh:t', connectionId: 't' }), 'ssh:t'],
      ['server row with explicit execution host', setup({ executionHostId: 'ssh:x' }), 'ssh:x']
    ])('%s', (_name, row, expectedExecutionHostId) => {
      const adopted = adoptFromEndpoint(SERVER, { kind: 'projectHostSetup', row })
      expect(adopted).toMatchObject({
        hostId: 'runtime:env-a',
        executionHostId: expectedExecutionHostId,
        runtimeOwnerEnvironmentId: 'env-a',
        connectionId: null
      })
    })
  })

  describe('folderWorkspace', () => {
    const groups = [group({ connectionId: 'conn-1' })]
    const resolveOwnHostId = (row: FolderWorkspace) => getFolderWorkspaceHostId(row, groups)

    it.each([
      ['row inheriting its group host', LOCAL, workspace(), 'ssh:conn-1'],
      ['row with its own SSH target', LOCAL, workspace({ connectionId: 'own' }), 'ssh:own'],
      ['row with an explicit host', LOCAL, workspace({ executionHostId: 'local' }), 'local'],
      ['server row', SERVER, workspace({ connectionId: 'nested' }), 'runtime:env-a']
    ])('%s', (_name, target, row, expectedHostId) => {
      const adopted = adoptFromEndpoint(target, { kind: 'folderWorkspace', row, resolveOwnHostId })
      expect(adopted.executionHostId).toBe(expectedHostId)
    })
  })

  describe('worktreeEvent', () => {
    const renamed = { oldWorktreeId: 'repo-1::/a', newWorktreeId: 'repo-1::/b' }

    it('pins an event from this app to this app, keeping the rename', () => {
      expect(
        adoptFromEndpoint(LOCAL, { kind: 'worktreeEvent', row: { repoId: 'repo-1', renamed } })
      ).toEqual({ repoId: 'repo-1', renamed, forceLocalOwner: true })
    })

    it('stamps an event from a server with that server', () => {
      expect(
        adoptFromEndpoint(SERVER, { kind: 'worktreeEvent', row: { repoId: 'repo-1' } })
      ).toEqual({ repoId: 'repo-1', executionHostId: 'runtime:env-a' })
    })
  })

  describe('createdWorktree', () => {
    const resolveOwnHostId = (): 'ssh:own' => 'ssh:own'

    it.each([
      ['this app, no requested host', LOCAL, undefined, 'ssh:own'],
      ['this app, requested SSH host', LOCAL, 'ssh:t', 'ssh:t'],
      ['server, no requested host', SERVER, undefined, 'runtime:env-a'],
      ['server, requested host', SERVER, 'runtime:env-a', 'runtime:env-a']
    ] as const)('%s', (_name, target, requestedHostId, expectedHostId) => {
      expect(
        adoptFromEndpoint(target, { kind: 'createdWorktree', requestedHostId, resolveOwnHostId })
      ).toBe(expectedHostId)
    })
  })
})
