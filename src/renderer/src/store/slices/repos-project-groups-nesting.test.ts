import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { ProjectGroup } from '../../../../shared/types'

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Platform',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const projectGroupsCreate = vi.fn()
const projectGroupsUpdate = vi.fn()
const projectGroupsList = vi.fn()

beforeEach(() => {
  projectGroupsCreate.mockReset()
  projectGroupsUpdate.mockReset()
  projectGroupsList.mockReset()
  projectGroupsList.mockResolvedValue([])
  vi.stubGlobal('window', {
    api: {
      projectGroups: {
        create: projectGroupsCreate,
        update: projectGroupsUpdate,
        list: projectGroupsList
      }
    }
  })
})

describe('project group nesting', () => {
  it('threads the parent group id through local subgroup creation', async () => {
    const subgroup = { ...projectGroup, id: 'group-2', name: 'Web', parentGroupId: 'group-1' }
    projectGroupsCreate.mockResolvedValue(subgroup)
    const store = createTestStore()

    await expect(
      store.getState().createProjectGroup('Web', { parentGroupId: 'group-1' })
    ).resolves.toEqual({ ...subgroup, executionHostId: 'local' })

    expect(projectGroupsCreate).toHaveBeenCalledWith({
      name: 'Web',
      parentGroupId: 'group-1',
      createdFrom: 'manual'
    })
  })

  it('reparents a local project group through updateProjectGroup', async () => {
    const parent = { ...projectGroup, id: 'parent-group', name: 'Parent' }
    const child = { ...projectGroup, id: 'child-group', name: 'Child', tabOrder: 1 }
    projectGroupsUpdate.mockResolvedValue({ ...child, parentGroupId: parent.id })
    const store = createTestStore()
    store.setState({ projectGroups: [parent, child] })

    await expect(
      store.getState().updateProjectGroup(child.id, { parentGroupId: parent.id, tabOrder: 0 })
    ).resolves.toBe(true)

    expect(projectGroupsUpdate).toHaveBeenCalledWith({
      groupId: child.id,
      updates: { parentGroupId: parent.id, tabOrder: 0 }
    })
    expect(
      store.getState().projectGroups.find((group) => group.id === child.id)?.parentGroupId
    ).toBe(parent.id)
  })

  it('rejects invalid reparent targets before any round-trip', async () => {
    const parent = { ...projectGroup, id: 'parent-group', name: 'Parent' }
    const child = {
      ...projectGroup,
      id: 'child-group',
      name: 'Child',
      parentGroupId: 'parent-group'
    }
    const store = createTestStore()
    store.setState({ projectGroups: [parent, child] })

    // Moving a group under its own descendant is a cycle.
    await expect(
      store.getState().updateProjectGroup(parent.id, { parentGroupId: child.id })
    ).resolves.toBe(false)

    expect(projectGroupsUpdate).not.toHaveBeenCalled()
  })

  it('reports failure when the host strips parentGroupId from the update', async () => {
    const parent = { ...projectGroup, id: 'parent-group', name: 'Parent' }
    const child = { ...projectGroup, id: 'child-group', name: 'Child' }
    // Hosts that predate nested groups return the group unchanged.
    projectGroupsUpdate.mockResolvedValue({ ...child, parentGroupId: null })
    projectGroupsList.mockResolvedValue([parent, child])
    const store = createTestStore()
    store.setState({ projectGroups: [parent, child] })

    await expect(
      store.getState().updateProjectGroup(child.id, { parentGroupId: parent.id })
    ).resolves.toBe(false)

    expect(
      store.getState().projectGroups.find((group) => group.id === child.id)?.parentGroupId
    ).toBeNull()
  })

  it('resyncs from the host when a compound update is partially persisted', async () => {
    const parent = { ...projectGroup, id: 'parent-group', name: 'Parent' }
    const child = { ...projectGroup, id: 'child-group', name: 'Child', tabOrder: 3 }
    // An old host strips parentGroupId but still persists the new tabOrder.
    projectGroupsUpdate.mockResolvedValue({ ...child, parentGroupId: null, tabOrder: 0 })
    projectGroupsList.mockResolvedValue([parent, { ...child, tabOrder: 0 }])
    const store = createTestStore()
    store.setState({ projectGroups: [parent, child] })

    await expect(
      store.getState().updateProjectGroup(child.id, { parentGroupId: parent.id, tabOrder: 0 })
    ).resolves.toBe(false)

    expect(projectGroupsList).toHaveBeenCalled()
    expect(store.getState().projectGroups.find((group) => group.id === child.id)?.tabOrder).toBe(0)
  })
})
