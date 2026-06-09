import { beforeEach, describe, expect, it, vi } from 'vitest'

const { asanaStatusMock, asanaConnectMock, asanaListTasksMock } = vi.hoisted(() => ({
  asanaStatusMock: vi.fn(),
  asanaConnectMock: vi.fn(),
  asanaListTasksMock: vi.fn()
}))

vi.mock('@/runtime/runtime-asana-client', () => ({
  asanaStatus: (...args: unknown[]) => asanaStatusMock(...args),
  asanaConnect: (...args: unknown[]) => asanaConnectMock(...args),
  asanaDisconnect: vi.fn(),
  asanaGetTask: vi.fn(),
  asanaListTasks: (...args: unknown[]) => asanaListTasksMock(...args),
  asanaSearchTasks: vi.fn(),
  asanaSelectWorkspace: vi.fn(),
  asanaTestConnection: vi.fn()
}))

import { createTestStore, seedStore } from './store-test-helpers'

function makeTask(overrides: Record<string, unknown>) {
  return {
    gid: '1',
    workspaceId: 'ws-1',
    workspaceName: 'Alpha',
    title: 'Original',
    url: 'https://app.asana.com/0/1/1',
    completed: false,
    projects: [],
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('asana slice', () => {
  it('marks the workspace connected after a successful connect', async () => {
    asanaConnectMock.mockResolvedValue({
      ok: true,
      viewer: { gid: 'u1', name: 'Ada', email: null }
    })
    asanaStatusMock.mockResolvedValue({
      connected: true,
      viewer: { gid: 'u1', name: 'Ada', email: null },
      workspaces: [{ id: 'ws-1', name: 'Alpha', userGid: 'u1', userName: 'Ada', userEmail: null }]
    })

    const store = createTestStore()
    await expect(store.getState().connectAsana({ apiToken: 'pat-1' })).resolves.toMatchObject({
      ok: true
    })
    expect(store.getState().asanaStatus.connected).toBe(true)
  })

  it('caches listed tasks and patches them optimistically', async () => {
    asanaListTasksMock.mockResolvedValue([makeTask({ gid: '1' })])

    const store = createTestStore()
    seedStore(store, {
      asanaStatus: { connected: true, viewer: null, selectedWorkspaceId: 'ws-1' }
    })

    const tasks = await store.getState().listAsanaTasks('assigned', 30)
    expect(tasks).toHaveLength(1)

    store.getState().patchAsanaTask('1', { completed: true })

    const cached = Object.values(store.getState().asanaSearchCache)[0]?.data
    expect(cached?.[0].completed).toBe(true)
  })

  it('forwards the project id and caches project-scoped lists separately', async () => {
    asanaListTasksMock.mockResolvedValue([makeTask({ gid: '1' })])

    const store = createTestStore()
    seedStore(store, {
      asanaStatus: { connected: true, viewer: null, selectedWorkspaceId: 'ws-1' }
    })

    await store.getState().listAsanaTasks('assigned', 30)
    await store.getState().listAsanaTasks('assigned', 30, 'proj-1')

    // The project id reaches the runtime client and keys a distinct cache entry.
    expect(asanaListTasksMock).toHaveBeenLastCalledWith(null, 'assigned', 30, 'ws-1', 'proj-1')
    expect(Object.keys(store.getState().asanaSearchCache)).toHaveLength(2)
  })
})
