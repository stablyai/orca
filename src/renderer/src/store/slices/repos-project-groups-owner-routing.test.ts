import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'

const folderScanGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Projects',
  parentPath: '/srv/projects',
  parentGroupId: null,
  createdFrom: 'folder-scan',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const baseRepo: Repo = {
  id: 'repo',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#111',
  addedAt: 1
}

const projectGroupsUpdate = vi.fn()
const projectGroupsDelete = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.clearAllMocks()
  projectGroupsUpdate.mockResolvedValue(null)
  projectGroupsDelete.mockResolvedValue(false)
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {},
      projectGroups: { update: projectGroupsUpdate, delete: projectGroupsDelete },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('project group mutations route to the owning host', () => {
  it('rejects a move to a group owned by another host', async () => {
    const sourceRepo: Repo = { ...baseRepo, executionHostId: 'local' }
    const destinationGroup: ProjectGroup = {
      ...folderScanGroup,
      executionHostId: 'runtime:env-1'
    }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null }),
      repos: [sourceRepo],
      projectGroups: [destinationGroup]
    })

    await expect(
      store.getState().moveProjectToGroup(sourceRepo, destinationGroup.id, 1)
    ).resolves.toBe(false)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('rejects a stale explicit hostId instead of mutating the focused same-ID group', async () => {
    projectGroupsUpdate.mockResolvedValue({
      ...folderScanGroup,
      executionHostId: 'local',
      name: 'Renamed'
    })
    projectGroupsDelete.mockResolvedValue(true)
    const localGroup = { ...folderScanGroup, executionHostId: 'local' as const }
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null }),
      projectGroups: [localGroup]
    })

    await expect(
      store
        .getState()
        .updateProjectGroup(folderScanGroup.id, { name: 'Renamed' }, { hostId: 'runtime:missing' })
    ).resolves.toBe(false)
    await expect(
      store.getState().deleteProjectGroup(folderScanGroup.id, { hostId: 'runtime:missing' })
    ).resolves.toBe(false)

    expect(projectGroupsUpdate).not.toHaveBeenCalled()
    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toEqual([localGroup])
  })

  it('rejects a colliding id with no unambiguous owner instead of using the focused host', async () => {
    projectGroupsDelete.mockResolvedValue(true)
    const store = createTestStore()
    store.setState({
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: null }),
      projectGroups: [
        { ...folderScanGroup, executionHostId: 'local' },
        { ...folderScanGroup, executionHostId: 'runtime:env-1' }
      ]
    })

    await expect(store.getState().deleteProjectGroup(folderScanGroup.id)).resolves.toBe(false)

    expect(projectGroupsDelete).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().projectGroups).toHaveLength(2)
  })
})
