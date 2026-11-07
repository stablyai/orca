import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { createTestStore } from '../testing/app-store-test-fixture'

describe('repos-project-group-create-race', () => {
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
  const refreshedGroup = { ...projectGroup, name: 'Renamed after creation', updatedAt: 2 }
  const otherHostGroup = { ...projectGroup, executionHostId: 'runtime:other' }

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function setup(runtimeEnvironmentId: string | null) {
    const created = Promise.withResolvers<ProjectGroup>()
    const createStarted = Promise.withResolvers<void>()
    const create = vi.fn(() => {
      createStarted.resolve()
      return created.promise
    })
    const list = vi.fn(async () => [refreshedGroup])
    vi.stubGlobal('window', {
      api: {
        projectGroups: { create, list },
        runtimeEnvironments: {
          call: async (request: RuntimeEnvironmentCallRequest) => {
            const compatibility = createCompatibleRuntimeStatusResponseIfNeeded(request)
            if (compatibility) {
              return compatibility
            }
            expect(request).toMatchObject({ selector: runtimeEnvironmentId })
            switch (request.method) {
              case 'projectGroup.create':
                return { id: 'create', ok: true, result: { group: await create() } }
              case 'projectGroup.list':
                return { id: 'list', ok: true, result: { groups: await list() } }
              default:
                throw new Error(`Unexpected RPC: ${request.method}`)
            }
          }
        }
      }
    })
    const store = createTestStore()
    store.setState({
      settings: {
        ...getDefaultSettings('/test'),
        activeRuntimeEnvironmentId: runtimeEnvironmentId
      },
      projectGroups: [otherHostGroup]
    })
    const ownerHostId: ExecutionHostId = runtimeEnvironmentId
      ? `runtime:${runtimeEnvironmentId}`
      : 'local'
    return { store, created, createStarted, ownerHostId }
  }

  describe.each([null, 'env-1'])('project group creation on host %s', (runtimeEnvironmentId) => {
    it('keeps the refreshed row without notifying subscribers when refresh finishes first', async () => {
      const { store, created, createStarted, ownerHostId } = setup(runtimeEnvironmentId)
      const pendingCreate = store.getState().createProjectGroup('Platform', ownerHostId)
      await createStarted.promise
      await store.getState().fetchProjectGroups(catalogOwner(store))
      const refreshedState = store.getState()
      const listener = vi.fn()
      const unsubscribe = store.subscribe(listener)
      try {
        created.resolve(projectGroup)
        await expect(pendingCreate).resolves.toEqual({
          ...projectGroup,
          executionHostId: ownerHostId
        })
        expect(store.getState()).toBe(refreshedState)
        expect(listener).not.toHaveBeenCalled()
        expect(store.getState().projectGroups).toEqual([
          otherHostGroup,
          { ...refreshedGroup, executionHostId: ownerHostId }
        ])
      } finally {
        unsubscribe()
      }
    })

    it('keeps the original owner when the focused host changes during creation', async () => {
      const { store, created, createStarted, ownerHostId } = setup(runtimeEnvironmentId)
      const pendingCreate = store.getState().createProjectGroup('Platform', ownerHostId)
      await createStarted.promise
      store.setState({
        settings: { ...getDefaultSettings('/test'), activeRuntimeEnvironmentId: 'other' }
      })
      await store.getState().fetchProjectGroups({ runtimeEnvironmentId })
      created.resolve(projectGroup)
      await pendingCreate
      expect(store.getState().projectGroups).toEqual([
        otherHostGroup,
        { ...refreshedGroup, executionHostId: ownerHostId }
      ])
    })

    it('does not roll back a successful refresh if the create response fails', async () => {
      const { store, created, createStarted, ownerHostId } = setup(runtimeEnvironmentId)
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const pendingCreate = store.getState().createProjectGroup('Platform', ownerHostId)
      await createStarted.promise
      await store.getState().fetchProjectGroups(catalogOwner(store))
      const refreshedState = store.getState()
      created.reject(new Error('Create response lost'))
      await expect(pendingCreate).resolves.toBeNull()
      expect(store.getState()).toBe(refreshedState)
    })
  })

  // The catalog these tests read is the one the focused host would have shown.
  function catalogOwner(store: {
    getState: () => { settings: { activeRuntimeEnvironmentId?: string | null } | null }
  }): { runtimeEnvironmentId: string | null } {
    return { runtimeEnvironmentId: store.getState().settings?.activeRuntimeEnvironmentId ?? null }
  }
})
