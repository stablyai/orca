// Require exact host row on removal: unique-candidate/focused fallbacks can destroy the other host’s same-ID project (#13071).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

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
