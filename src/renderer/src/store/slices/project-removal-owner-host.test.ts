/**
 * #13071: a project id can exist on several hosts. Removing one host's project must
 * never resolve the bare id to another host's row (the unique-candidate or
 * focused-host fallback), or the other host's live project is destroyed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { purgeOrphanedRuntimeSshProjects } from './worktrees/teardown/orphaned-runtime-ssh-project-purge'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const baseRepo: Repo = {
  id: 'same-repo',
  path: '/work/same',
  displayName: 'Same',
  badgeColor: '#000',
  addedAt: 1
}
const localRow: Repo = { ...baseRepo, executionHostId: 'local' }
const sshRow: Repo = {
  ...baseRepo,
  path: '/remote/same',
  connectionId: 'target-1',
  executionHostId: 'ssh:target-1'
}
const runtimeRow: Repo = {
  ...baseRepo,
  path: '/server/same',
  executionHostId: 'runtime:env-b'
}

const group: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1,
  executionHostId: 'local'
}

const reposRemove = vi.fn()
const reposRemoveForHost = vi.fn()
const projectGroupsDelete = vi.fn()
const runtimeCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  for (const mock of [reposRemove, reposRemoveForHost, projectGroupsDelete, runtimeCall]) {
    mock.mockReset()
  }
  reposRemove.mockResolvedValue(undefined)
  reposRemoveForHost.mockResolvedValue(undefined)
  projectGroupsDelete.mockResolvedValue(true)
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
      projectGroups: { delete: projectGroupsDelete },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: runtimeCall },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

describe('project removal stays on its owner host (#13071)', () => {
  it('leaves the only remaining row alone when the named host has no row', async () => {
    const store = createTestStore()
    // Host A's row dropped from the catalog; host B's row is the unique candidate for the id.
    store.setState({ repos: [runtimeRow] })

    await store.getState().removeProject('same-repo', { hostId: 'local' })

    expect(store.getState().repos).toEqual([runtimeRow])
    expect(reposRemove).not.toHaveBeenCalled()
    expect(reposRemoveForHost).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('purges a destroyed SSH host row without touching the same id on the focused host', async () => {
    const store = createTestStore()
    store.setState({ repos: [localRow, sshRow] })

    await purgeOrphanedRuntimeSshProjects(store.getState, ['target-1'])

    expect(store.getState().repos).toEqual([localRow])
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: 'same-repo',
      hostId: 'ssh:target-1'
    })
    expect(reposRemove).not.toHaveBeenCalled()
  })

  it('removes every row an owned group holds under the id, each on its own host', async () => {
    const store = createTestStore()
    store.setState({
      projectGroups: [group],
      repos: [
        { ...localRow, projectGroupId: group.id },
        { ...sshRow, projectGroupId: group.id },
        runtimeRow
      ]
    })

    const result = await store.getState().deleteProjectGroupWithContainedProjects(group.id, {
      removeContainedProjects: true,
      hostId: 'local'
    })

    expect(result).toMatchObject({
      removedProjectIds: ['same-repo'],
      failedProjectRemovals: []
    })
    // The runtime host's row is outside the local catalog and must survive.
    expect(store.getState().repos).toEqual([runtimeRow])
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: 'same-repo',
      hostId: 'local'
    })
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: 'same-repo',
      hostId: 'ssh:target-1'
    })
    expect(runtimeCall).not.toHaveBeenCalled()
  })

  it('keeps a same-id row on another host that sits outside the deleted group', async () => {
    const store = createTestStore()
    const otherGroup: ProjectGroup = { ...group, id: 'group-2', name: 'Other' }
    const outsideSshRow: Repo = { ...sshRow, projectGroupId: otherGroup.id }
    store.setState({
      projectGroups: [group, otherGroup],
      repos: [{ ...localRow, projectGroupId: group.id }, outsideSshRow]
    })

    const result = await store.getState().deleteProjectGroupWithContainedProjects(group.id, {
      removeContainedProjects: true,
      hostId: 'local'
    })

    expect(result).toMatchObject({
      removedProjectIds: ['same-repo'],
      failedProjectRemovals: []
    })
    expect(store.getState().repos).toEqual([outsideSshRow])
    expect(reposRemoveForHost).toHaveBeenCalledTimes(1)
    expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'same-repo', hostId: 'local' })
  })

  it('removes only the member row of an unstamped group, not the focused-host non-member', async () => {
    const store = createTestStore()
    const unstampedGroup: ProjectGroup = { ...group, executionHostId: undefined }
    const memberSshRow: Repo = { ...sshRow, projectGroupId: unstampedGroup.id }
    store.setState({ projectGroups: [unstampedGroup], repos: [localRow, memberSshRow] })

    const result = await store.getState().deleteProjectGroupWithContainedProjects(group.id, {
      removeContainedProjects: true
    })

    expect(result).toMatchObject({
      removedProjectIds: ['same-repo'],
      failedProjectRemovals: []
    })
    expect(store.getState().repos).toEqual([localRow])
    expect(reposRemoveForHost).toHaveBeenCalledTimes(1)
    expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'same-repo', hostId: 'ssh:target-1' })
  })
})

describe('removal stays host-scoped when this catalog is stale (#13071)', () => {
  type MainRow = { id: string; hostId: string; kind: 'git' | 'folder' }

  // Mirrors the main catalog: id-only removal drops every host's row, removeForHost one row.
  function stubMainCatalog(rows: MainRow[]): { current: MainRow[] } {
    const main = { current: rows }
    reposRemove.mockImplementation(async ({ repoId }: { repoId: string }) => {
      main.current = main.current.filter((row) => row.id !== repoId)
    })
    reposRemoveForHost.mockImplementation(
      async ({ repoId, hostId }: { repoId: string; hostId: string }) => {
        main.current = main.current.filter((row) => !(row.id === repoId && row.hostId === hostId))
      }
    )
    return main
  }

  it.each(['git', 'folder'] as const)(
    'keeps an unseen same-id SSH %s project when removing the local one',
    async (kind) => {
      const main = stubMainCatalog([
        { id: 'same-repo', hostId: 'local', kind },
        { id: 'same-repo', hostId: 'ssh:target-1', kind }
      ])
      const store = createTestStore()
      // Another window added the SSH twin; this renderer has not refreshed yet.
      store.setState({ repos: [{ ...localRow, kind }] })

      await store.getState().removeProject('same-repo', { hostId: 'local' })

      expect(reposRemove).not.toHaveBeenCalled()
      expect(reposRemoveForHost).toHaveBeenCalledWith({ repoId: 'same-repo', hostId: 'local' })
      expect(main.current).toEqual([{ id: 'same-repo', hostId: 'ssh:target-1', kind }])
    }
  )

  it.each(['git', 'folder'] as const)(
    'removes a direct SSH %s project without touching an unseen local twin',
    async (kind) => {
      const main = stubMainCatalog([
        { id: 'same-repo', hostId: 'local', kind },
        { id: 'same-repo', hostId: 'ssh:target-1', kind }
      ])
      const store = createTestStore()
      store.setState({ repos: [{ ...sshRow, kind }] })

      await store.getState().removeProject('same-repo', { hostId: 'ssh:target-1' })

      expect(reposRemove).not.toHaveBeenCalled()
      expect(main.current).toEqual([{ id: 'same-repo', hostId: 'local', kind }])
    }
  )

  it('never falls back to id-only removal when the selected row is already gone in main', async () => {
    const main = stubMainCatalog([{ id: 'same-repo', hostId: 'ssh:target-1', kind: 'git' }])
    const store = createTestStore()
    store.setState({ repos: [localRow] })

    await store.getState().removeProject('same-repo', { hostId: 'local' })

    expect(reposRemove).not.toHaveBeenCalled()
    expect(main.current).toEqual([{ id: 'same-repo', hostId: 'ssh:target-1', kind: 'git' }])
  })
})
