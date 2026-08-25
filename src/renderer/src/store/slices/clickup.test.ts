import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { ClickUpTask, ClickUpViewer } from '../../../../shared/clickup-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { createClickUpSlice } from './clickup'
import { CLICKUP_DEFAULT_CACHE_SCOPE } from './clickup-task-cache-patch'

const clickUpStatus = vi.fn()
const clickUpGetTask = vi.fn()
const clickUpListTasks = vi.fn()
const clickUpSearchTasks = vi.fn()
const clickUpSelectWorkspace = vi.fn()

vi.mock('@/runtime/runtime-clickup-client', () => ({
  clickUpConnect: vi.fn(),
  clickUpDisconnect: vi.fn(),
  clickUpGetTask: (...args: unknown[]) => clickUpGetTask(...args),
  clickUpListTasks: (...args: unknown[]) => clickUpListTasks(...args),
  clickUpSearchTasks: (...args: unknown[]) => clickUpSearchTasks(...args),
  clickUpSelectWorkspace: (...args: unknown[]) => clickUpSelectWorkspace(...args),
  clickUpStatus: (...args: unknown[]) => clickUpStatus(...args),
  clickUpTestConnection: vi.fn()
}))

function createTestStore() {
  return create<AppState>()(
    (...args) =>
      ({
        settings: null,
        ...createClickUpSlice(...args)
      }) as AppState
  )
}

function task(id: string, title = id): ClickUpTask {
  return {
    id,
    customId: null,
    workspaceId: 'team-1',
    workspaceName: 'Engineering',
    name: title,
    url: `https://app.clickup.com/t/${id}`,
    status: { name: 'open', color: '#123456', type: 'custom', orderIndex: 0 },
    priority: null,
    assignees: [],
    tags: [],
    list: { id: 'list-1', name: 'Backlog' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    closedAt: null
  }
}

function sourceContext(environmentId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'clickup',
    projectId: 'project-1',
    hostId: `runtime:${environmentId}`,
    providerIdentity: { provider: 'clickup', workspaceId: 'team-1' }
  }
}

describe('createClickUpSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ignores a stale status response after the selected runtime changes', async () => {
    let resolveLocal!: (value: { connected: true; viewer: ClickUpViewer }) => void
    const local = new Promise<{ connected: true; viewer: ClickUpViewer }>((resolve) => {
      resolveLocal = resolve
    })
    clickUpStatus.mockReturnValueOnce(local).mockResolvedValueOnce({
      connected: true,
      viewer: { id: 2, username: 'Remote', email: null }
    })
    const store = createTestStore()

    const first = store.getState().checkClickUpConnection()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'runtime-1' } as never })
    await store.getState().checkClickUpConnection()
    resolveLocal({ connected: true, viewer: { id: 1, username: 'Local', email: null } })
    await first

    expect(store.getState().clickUpStatus.viewer?.username).toBe('Remote')
  })

  it('scopes task caches and optimistic patches to the task source host', async () => {
    const store = createTestStore()
    const local = sourceContext('local')
    const remote = sourceContext('remote')
    clickUpGetTask
      .mockResolvedValueOnce(task('abc', 'Local task'))
      .mockResolvedValueOnce(task('abc', 'Remote task'))

    await store.getState().fetchClickUpTask('abc', 'team-1', { sourceContext: local })
    await store.getState().fetchClickUpTask('abc', 'team-1', { sourceContext: remote })
    store.getState().patchClickUpTask('abc', { name: 'Patched local' }, local)

    const localKey = `${getTaskSourceCacheScope(local)}::team-1::task::abc`
    const remoteKey = `${getTaskSourceCacheScope(remote)}::team-1::task::abc`
    expect(store.getState().clickUpTaskCache[localKey]?.data?.name).toBe('Patched local')
    expect(store.getState().clickUpTaskCache[remoteKey]?.data?.name).toBe('Remote task')
  })

  it('keeps unscoped optimistic patches out of explicit task-source caches', async () => {
    const store = createTestStore()
    const remote = sourceContext('remote')
    clickUpGetTask
      .mockResolvedValueOnce(task('abc', 'Local task'))
      .mockResolvedValueOnce(task('abc', 'Remote task'))

    await store.getState().fetchClickUpTask('abc', 'team-1')
    await store.getState().fetchClickUpTask('abc', 'team-1', { sourceContext: remote })
    store.getState().patchClickUpTask('abc', { name: 'Patched local' })

    const localKey = `${CLICKUP_DEFAULT_CACHE_SCOPE}::team-1::task::abc`
    const remoteKey = `${getTaskSourceCacheScope(remote)}::team-1::task::abc`
    expect(store.getState().clickUpTaskCache[localKey]?.data?.name).toBe('Patched local')
    expect(store.getState().clickUpTaskCache[remoteKey]?.data?.name).toBe('Remote task')
  })

  it('serves fresh list caches without issuing another ClickUp request', async () => {
    const store = createTestStore()
    store.setState({
      clickUpStatus: {
        connected: true,
        viewer: null,
        selectedWorkspaceId: 'team-1'
      }
    })
    clickUpListTasks.mockResolvedValueOnce([task('abc')])

    await store.getState().listClickUpTasks('assigned', 20)
    await store.getState().listClickUpTasks('assigned', 20)

    expect(clickUpListTasks).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['search', clickUpSearchTasks],
    ['list', clickUpListTasks]
  ])('does not cache a stale %s response after a Workspace switch', async (kind, requestMock) => {
    let resolveRequest!: (tasks: ClickUpTask[]) => void
    requestMock.mockReturnValueOnce(
      new Promise<ClickUpTask[]>((resolve) => {
        resolveRequest = resolve
      })
    )
    clickUpSelectWorkspace.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'team-2'
    })
    const store = createTestStore()
    store.setState({
      clickUpStatus: { connected: true, viewer: null, selectedWorkspaceId: 'team-1' }
    })

    const pending =
      kind === 'search'
        ? store.getState().searchClickUpTasks('abc', 20)
        : store.getState().listClickUpTasks('assigned', 20)
    await store.getState().selectClickUpWorkspace('team-2')
    resolveRequest([task('abc')])
    await pending

    expect(store.getState().clickUpSearchCache).toEqual({})
    expect(store.getState().clickUpListCache).toEqual({})
  })

  it('updates the status context key after selecting a Workspace', async () => {
    clickUpSelectWorkspace.mockResolvedValue({
      connected: true,
      viewer: null,
      selectedWorkspaceId: 'team-2'
    })
    const store = createTestStore()

    await store.getState().selectClickUpWorkspace('team-2')

    expect(store.getState().clickUpStatusContextKey).not.toBeNull()
  })
})
