import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { PlaneCollectionResult, PlaneWorkItem } from '../../../../shared/plane/types'
import { createPlaneSlice } from './plane'

const planeStatus = vi.fn()
const planeConnect = vi.fn()
const planeConnectOAuth = vi.fn()
const planeDisconnect = vi.fn()
const planeListIssues = vi.fn()
const planeListProjects = vi.fn()
const planeListMembers = vi.fn()
const planeListStates = vi.fn()
const planeListLabels = vi.fn()
const planeListCycles = vi.fn()
const planeListModules = vi.fn()
const planeListWorkItemTypes = vi.fn()
const planeListEstimates = vi.fn()
const planeTestConnection = vi.fn()

vi.mock('@/runtime/runtime-plane-client', () => ({
  planeConnect: (...args: unknown[]) => planeConnect(...args),
  planeConnectOAuth: (...args: unknown[]) => planeConnectOAuth(...args),
  planeDisconnect: (...args: unknown[]) => planeDisconnect(...args),
  planeListCycles: (...args: unknown[]) => planeListCycles(...args),
  planeListEstimates: (...args: unknown[]) => planeListEstimates(...args),
  planeListIssues: (...args: unknown[]) => planeListIssues(...args),
  planeListLabels: (...args: unknown[]) => planeListLabels(...args),
  planeListMembers: (...args: unknown[]) => planeListMembers(...args),
  planeListModules: (...args: unknown[]) => planeListModules(...args),
  planeListProjects: (...args: unknown[]) => planeListProjects(...args),
  planeListStates: (...args: unknown[]) => planeListStates(...args),
  planeListWorkItemTypes: (...args: unknown[]) => planeListWorkItemTypes(...args),
  planeStatus: (...args: unknown[]) => planeStatus(...args),
  planeTestConnection: (...args: unknown[]) => planeTestConnection(...args)
}))

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: null,
        ...createPlaneSlice(...a)
      }) as AppState
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function issue(id: string): PlaneWorkItem {
  return {
    id,
    identifier: id,
    title: id,
    url: `https://plane.example/${id}`,
    project: { id: 'project-1', name: 'Project', identifier: 'PRO' },
    workspaceSlug: 'workspace',
    instanceId: 'instance-1'
  }
}

describe('createPlaneSlice cached reads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dedupes concurrent issue list reads for the same query', async () => {
    const store = createTestStore()
    const result = deferred<PlaneCollectionResult<PlaneWorkItem>>()
    planeListIssues.mockReturnValueOnce(result.promise)

    const first = store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    const second = store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    result.resolve({ items: [issue('PRO-1')] })

    await expect(first).resolves.toMatchObject({ items: [{ id: 'PRO-1' }] })
    await expect(second).resolves.toMatchObject({ items: [{ id: 'PRO-1' }] })
    expect(planeListIssues).toHaveBeenCalledTimes(1)
  })

  it('serves fresh cached issues and force refreshes on demand', async () => {
    const store = createTestStore()
    planeListIssues
      .mockResolvedValueOnce({ items: [issue('PRO-1')] })
      .mockResolvedValueOnce({ items: [issue('PRO-2')] })

    await expect(
      store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    ).resolves.toMatchObject({ items: [{ id: 'PRO-1' }] })
    await expect(
      store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    ).resolves.toMatchObject({ items: [{ id: 'PRO-1' }] })
    await expect(
      store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1', { force: true })
    ).resolves.toMatchObject({ items: [{ id: 'PRO-2' }] })

    expect(planeListIssues).toHaveBeenCalledTimes(2)
  })

  it('falls back to stale cached issues after a transient failure', async () => {
    const store = createTestStore()
    planeListIssues
      .mockResolvedValueOnce({ items: [issue('PRO-1')] })
      .mockRejectedValueOnce(new Error('network down'))

    await store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    await expect(
      store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1', { force: true })
    ).resolves.toMatchObject({ items: [{ id: 'PRO-1' }] })
  })

  it('isolates ambient issue caches by focused runtime context', async () => {
    const store = createTestStore()
    planeListIssues
      .mockResolvedValueOnce({ items: [issue('LOCAL-1')] })
      .mockResolvedValueOnce({ items: [issue('REMOTE-1')] })

    await expect(
      store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    ).resolves.toMatchObject({ items: [{ id: 'LOCAL-1' }] })
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    await expect(
      store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    ).resolves.toMatchObject({ items: [{ id: 'REMOTE-1' }] })

    expect(planeListIssues).toHaveBeenCalledTimes(2)
  })

  it('clears cached reads after disconnect mutates credentials', async () => {
    const store = createTestStore()
    planeListIssues.mockResolvedValueOnce({ items: [issue('PRO-1')] })
    planeDisconnect.mockResolvedValueOnce(undefined)
    planeStatus.mockResolvedValueOnce({
      connected: false,
      activeInstanceId: null,
      selectedInstanceId: null,
      instances: [],
      viewer: null
    })

    await store.getState().listPlaneIssues({ preset: 'open' }, 30, 'instance-1')
    expect(Object.keys(store.getState().planeIssueListCache)).toHaveLength(1)
    await store.getState().disconnectPlane('instance-1')

    expect(store.getState().planeIssueListCache).toEqual({})
  })

  it('keeps project resources isolated by project id', async () => {
    const store = createTestStore()
    planeListStates.mockResolvedValue([])
    planeListLabels.mockResolvedValue([])
    planeListCycles.mockResolvedValue([])
    planeListModules.mockResolvedValue([])
    planeListWorkItemTypes.mockResolvedValue([])
    planeListEstimates.mockResolvedValue([])

    await store.getState().listPlaneProjectResources('project-1', 'instance-1')
    await store.getState().listPlaneProjectResources('project-2', 'instance-1')

    expect(planeListStates).toHaveBeenCalledTimes(2)
    expect(planeListStates).toHaveBeenNthCalledWith(1, null, 'project-1', 'instance-1')
    expect(planeListStates).toHaveBeenNthCalledWith(2, null, 'project-2', 'instance-1')
  })
})
