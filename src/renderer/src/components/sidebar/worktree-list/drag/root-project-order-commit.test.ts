import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup, ProjectGroupUpdate } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY } from '../../../../../../shared/project-group-order-capability'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { saveRootProjectOrderForSidebarDrop } from './root-project-order-commit'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
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
function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 1, ...overrides }
}

beforeEach(() => clearRuntimeCompatibilityCache())

describe('saving root project order', () => {
  it('inserts a project among legacy groups and preserves their relative order', async () => {
    const groups = [group('a'), group('b', { tabOrder: 1 }), group('c', { tabOrder: 2 })]
    const project = repo('x')
    const store = createTestStore()
    store.setState({ projectGroups: groups, repos: [project] })
    vi.stubGlobal('window', {
      api: {
        projectGroups: {
          updateMany: async ({
            mutations
          }: {
            mutations: { groupId: string; updates: ProjectGroupUpdate }[]
          }) =>
            mutations
              .map(({ groupId, updates }) => ({
                ...groups.find((entry) => entry.id === groupId),
                ...updates
              }))
              .toReversed()
        },
        repos: {
          update: async ({ updates }: { updates: Partial<Repo> }) => ({ ...project, ...updates })
        }
      }
    })

    await expect(
      saveRootProjectOrderForSidebarDrop({
        state: store.getState(),
        visibleKeys: ['group:a', 'group:b', 'group:c', 'repo:x'],
        draggedKey: 'repo:x',
        dropIndex: 1,
        onCommit: () => {}
      })
    ).resolves.toBe(true)
    expect(store.getState().projectGroups).toMatchObject([
      { id: 'a', tabOrder: 0 },
      { id: 'b', rootProjectOrder: 1000, tabOrder: 1 },
      { id: 'c', rootProjectOrder: 2000, tabOrder: 2 }
    ])
    expect(store.getState().repos).toMatchObject([{ id: 'x', projectGroupOrder: 0 }])
  })

  it('persists the moved logical group on both owners and leaves unrelated roots intact', async () => {
    const local = group('a', { rootProjectOrder: 0 })
    const remote = { ...local, executionHostId: 'runtime:remote' }
    const last = group('b', { rootProjectOrder: 2000, tabOrder: 1 })
    const project = repo('x', { projectGroupOrder: 1000 })
    const store = createTestStore()
    store.setState({ projectGroups: [local, remote, last], repos: [project] })
    vi.stubGlobal('window', {
      api: {
        projectGroups: {
          update: async ({ updates }: { updates: Partial<ProjectGroup> }) => ({
            ...local,
            ...updates
          })
        },
        runtimeEnvironments: {
          call: async (request: RuntimeEnvironmentCallRequest) => {
            if (request.method === 'status.get') {
              return createCompatibleRuntimeStatusResponse()
            }
            return {
              id: 'update',
              ok: true,
              result: {
                group: {
                  ...remote,
                  ...(request.params?.updates && typeof request.params.updates === 'object'
                    ? request.params.updates
                    : {})
                }
              },
              _meta: { runtimeId: 'remote-runtime' }
            }
          }
        }
      }
    })

    await expect(
      saveRootProjectOrderForSidebarDrop({
        state: store.getState(),
        visibleKeys: ['group:a', 'repo:x', 'group:b'],
        draggedKey: 'group:a',
        dropIndex: 2,
        onCommit: () => {}
      })
    ).resolves.toBe(true)
    expect(store.getState().projectGroups).toMatchObject([
      { id: 'a', rootProjectOrder: 1500, tabOrder: 0 },
      { id: 'a', executionHostId: 'runtime:remote', rootProjectOrder: 1500, tabOrder: 0 },
      { id: 'b', rootProjectOrder: 2000, tabOrder: 1 }
    ])
    expect(store.getState().repos).toEqual([project])
  })

  it('preserves unloaded group membership when changing a project rank', async () => {
    const orphan = repo('orphan', { projectGroupId: 'loading-group', projectGroupOrder: 2000 })
    const other = repo('x', { projectGroupOrder: 1000 })
    const store = createTestStore()
    store.setState({ projectGroups: [group('a', { rootProjectOrder: 0 })], repos: [other, orphan] })
    vi.stubGlobal('window', {
      api: {
        repos: {
          update: async ({ updates }: { updates: Partial<Repo> }) => ({ ...orphan, ...updates })
        }
      }
    })

    await expect(
      saveRootProjectOrderForSidebarDrop({
        state: store.getState(),
        visibleKeys: ['group:a', 'repo:x', 'repo:orphan'],
        draggedKey: 'repo:orphan',
        dropIndex: 1,
        onCommit: () => {}
      })
    ).resolves.toBe(true)
    expect(store.getState().repos).toMatchObject([
      { id: 'x', projectGroupOrder: 1000 },
      { id: 'orphan', projectGroupId: 'loading-group', projectGroupOrder: 500 }
    ])
  })

  it('leaves the entire order intact when a required peer lacks root rank support', async () => {
    const groups = [group('a'), group('b', { tabOrder: 1, executionHostId: 'runtime:remote' })]
    const projects = [repo('x')]
    const store = createTestStore()
    store.setState({ projectGroups: groups, repos: projects })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: async () => {
            const response = createCompatibleRuntimeStatusResponse()
            response.result.capabilities = response.result.capabilities?.filter(
              (capability) => capability !== PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
            )
            return response
          }
        }
      }
    })

    await expect(
      saveRootProjectOrderForSidebarDrop({
        state: store.getState(),
        visibleKeys: ['group:a', 'group:b', 'repo:x'],
        draggedKey: 'repo:x',
        dropIndex: 1,
        onCommit: () => {}
      })
    ).resolves.toBe(false)
    expect(store.getState().projectGroups).toEqual(groups)
    expect(store.getState().repos).toEqual(projects)
  })
  it('reports failure when a peer acknowledges an update without storing its rank', async () => {
    const remote = group('a', { executionHostId: 'runtime:remote', rootProjectOrder: 0 })
    const store = createTestStore()
    store.setState({ projectGroups: [remote] })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: async (request: RuntimeEnvironmentCallRequest) => {
            if (request.method === 'status.get') {
              return createCompatibleRuntimeStatusResponse()
            }
            return {
              id: 'update',
              ok: true,
              result: { group: remote },
              _meta: { runtimeId: 'remote-runtime' }
            }
          }
        }
      }
    })
    await expect(
      store
        .getState()
        .updateProjectGroup('a', { rootProjectOrder: 1000 }, { hostId: 'runtime:remote' })
    ).resolves.toBe(false)
    expect(store.getState().projectGroups).toEqual([remote])
  })
  it('restores successful owner copies when another owner rejects the move', async () => {
    const local = group('a', { executionHostId: 'local' })
    const remote = { ...local, executionHostId: 'runtime:remote' }
    let persistedLocal = { ...local }
    const store = createTestStore()
    store.setState({ projectGroups: [local, remote], repos: [repo('x', { projectGroupOrder: 0 })] })
    vi.stubGlobal('window', {
      api: {
        projectGroups: {
          update: async ({ updates }: { updates: ProjectGroupUpdate }) => {
            if (updates.rootProjectOrder === null) {
              delete persistedLocal.rootProjectOrder
            } else if (updates.rootProjectOrder !== undefined) {
              persistedLocal.rootProjectOrder = updates.rootProjectOrder
            }
            return { ...persistedLocal }
          }
        },
        runtimeEnvironments: {
          call: async (request: RuntimeEnvironmentCallRequest) => {
            if (request.method === 'status.get') {
              return createCompatibleRuntimeStatusResponse()
            }
            return {
              id: 'update',
              ok: true,
              result: { group: null },
              _meta: { runtimeId: 'remote-runtime' }
            }
          }
        }
      }
    })
    await expect(
      saveRootProjectOrderForSidebarDrop({
        state: store.getState(),
        visibleKeys: ['group:a', 'repo:x'],
        draggedKey: 'group:a',
        dropIndex: 2,
        onCommit: () => {}
      })
    ).resolves.toBe(false)
    expect(store.getState().projectGroups).toEqual([local, remote])
    expect(persistedLocal.rootProjectOrder).toBeUndefined()
  })

  it('restores an absent project rank when a group rejects the move', async () => {
    const project = repo('x', { executionHostId: 'local' })
    let persistedProject = { ...project }
    const groups = [group('a'), group('b', { tabOrder: 1 })]
    const store = createTestStore()
    store.setState({ projectGroups: groups, repos: [project] })
    vi.stubGlobal('window', {
      api: {
        repos: {
          update: async ({ updates }: { updates: { projectGroupOrder?: number | null } }) => {
            if (updates.projectGroupOrder === null) {
              delete persistedProject.projectGroupOrder
            } else if (updates.projectGroupOrder !== undefined) {
              persistedProject.projectGroupOrder = updates.projectGroupOrder
            }
            return { ...persistedProject }
          }
        },
        projectGroups: { update: async () => null }
      }
    })
    await expect(
      saveRootProjectOrderForSidebarDrop({
        state: store.getState(),
        visibleKeys: ['group:a', 'group:b', 'repo:x'],
        draggedKey: 'repo:x',
        dropIndex: 1,
        onCommit: () => {}
      })
    ).resolves.toBe(false)
    expect(persistedProject).toEqual(project)
    expect(store.getState().repos).toEqual([project])
  })

  it('merges confirmed initial ranks into a group already refreshed by the catalog', async () => {
    const remote = group('remote', { rootProjectOrder: 4000, tabOrder: 4 })
    const created = group('new')
    const started = Promise.withResolvers<void>()
    const updated = Promise.withResolvers<ProjectGroup>()
    const store = createTestStore()
    store.setState({ projectGroups: [remote], repos: [repo('x', { projectGroupOrder: 5000 })] })
    vi.stubGlobal('window', {
      api: {
        projectGroups: {
          create: async () => created,
          update: () => {
            started.resolve()
            return updated.promise
          }
        }
      }
    })
    const pending = store.getState().createProjectGroup('new', 'local')
    await started.promise
    store.setState({
      projectGroups: [
        remote,
        { ...created, executionHostId: 'local', name: 'Renamed', isCollapsed: true, updatedAt: 2 }
      ]
    })
    updated.resolve({ ...created, rootProjectOrder: 6000, tabOrder: 1004 })
    await pending
    expect(store.getState().projectGroups).toMatchObject([
      { id: 'remote', rootProjectOrder: 4000, tabOrder: 4 },
      {
        id: 'new',
        name: 'Renamed',
        isCollapsed: true,
        updatedAt: 2,
        rootProjectOrder: 6000,
        tabOrder: 1004
      }
    ])
  })

  it('appends a new group after ranked roots from the merged host catalog', async () => {
    const remote = group('remote', {
      executionHostId: 'runtime:remote',
      rootProjectOrder: 4000,
      tabOrder: 4
    })
    const created = group('new')
    const store = createTestStore()
    store.setState({ projectGroups: [remote], repos: [repo('x', { projectGroupOrder: 5000 })] })
    vi.stubGlobal('window', {
      api: {
        projectGroups: {
          create: async () => created,
          update: async ({ updates }: { updates: ProjectGroupUpdate }) => ({
            ...created,
            ...updates
          })
        }
      }
    })
    await expect(store.getState().createProjectGroup('new', 'local')).resolves.toMatchObject({
      id: 'new',
      rootProjectOrder: 6000,
      tabOrder: 1004
    })
    expect(store.getState().projectGroups).toMatchObject([
      { id: 'remote', rootProjectOrder: 4000, tabOrder: 4 },
      { id: 'new', rootProjectOrder: 6000, tabOrder: 1004 }
    ])
  })
})
