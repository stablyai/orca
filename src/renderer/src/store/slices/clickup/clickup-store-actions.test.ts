import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ClickUpConnectionStatus,
  ClickUpStatusOption,
  ClickUpTask
} from '../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { createTestStore } from '../../testing/app-store-test-fixture'
import {
  clickupListCacheKey,
  clickupOwnerContextKey,
  clickupTaskCacheKey
} from './clickup-read-coordination'

const api = vi.hoisted(() => ({
  selectWorkspace: vi.fn(),
  status: vi.fn(),
  disconnect: vi.fn(),
  getTask: vi.fn(),
  updateTask: vi.fn(),
  listTasks: vi.fn()
}))

vi.mock('@/runtime/clickup/runtime-clickup-client', () => ({
  clickupApiForTarget: () => api,
  clickupSearchTasksForTarget: vi.fn()
}))
vi.mock('@/runtime/clickup/runtime-clickup-capability', () => ({
  clickupRuntimeSupported: () => Promise.resolve(true)
}))

const owner = { kind: 'local' } as const
const ALL = { scope: 'all', includeClosed: false } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function connectedStatus(selectedWorkspaceId: string): ClickUpConnectionStatus {
  return {
    connected: true,
    viewer: { id: 'u1', username: 'ana', email: 'ana@example.com' },
    workspaces: [
      { id: 'A', name: 'Alpha' },
      { id: 'B', name: 'Beta' }
    ],
    selectedWorkspaceId
  }
}

function statusOption(name: string): ClickUpStatusOption {
  return { name, color: '#888888', type: 'custom', orderIndex: 1 }
}

function task(statusName: string): ClickUpTask {
  return {
    id: 'abc123',
    customId: null,
    name: 'Fix the login',
    descriptionMarkdown: '',
    status: statusOption(statusName),
    priority: null,
    assignees: [],
    creator: null,
    tags: [],
    url: 'https://app.clickup.com/t/abc123',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dueAt: null,
    list: { id: 'list-1', name: 'Sprint' },
    folder: null,
    spaceId: 'space-1',
    workspaceId: 'A',
    parentId: null
  }
}

function sourceContext(projectId: string): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'clickup',
    projectId,
    hostId: 'local',
    providerIdentity: { provider: 'clickup', workspaceId: 'A' }
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('ClickUp connection actions', () => {
  it('keeps the selected Workspace when a status read that overlapped the switch settles late', async () => {
    const store = createTestStore()
    const switching = deferred<ClickUpConnectionStatus>()
    const lateRead = deferred<ClickUpConnectionStatus>()
    api.selectWorkspace.mockReturnValue(switching.promise)
    api.status.mockReturnValue(lateRead.promise)

    const select = store.getState().selectClickUpWorkspace(owner, 'B')
    const check = store.getState().checkClickUpConnection(owner)
    switching.resolve(connectedStatus('B'))
    await select
    lateRead.resolve(connectedStatus('A'))
    await check

    expect(store.getState().clickupStatus.selectedWorkspaceId).toBe('B')
  })

  it('shows ClickUp as disconnected once disconnect succeeds, even if the status read fails', async () => {
    const store = createTestStore()
    store.setState({
      clickupStatus: connectedStatus('A'),
      clickupStatusChecked: true,
      clickupStatusContextKey: clickupOwnerContextKey(owner),
      clickupTaskCache: { stale: { data: task('Open'), fetchedAt: 1 } }
    })
    api.disconnect.mockResolvedValue(undefined)
    api.status.mockRejectedValue(new Error('offline'))

    await store.getState().disconnectClickUp(owner)

    expect(store.getState().clickupStatus.connected).toBe(false)
    expect(store.getState().clickupTaskCache).toEqual({})
  })
})

describe('ClickUp task reads', () => {
  it('stops serving a cached task once a forced read finds it gone', async () => {
    const store = createTestStore()
    const options = { sourceContext: sourceContext('p1') }
    api.getTask.mockResolvedValueOnce(task('Open')).mockResolvedValueOnce(null)

    await store.getState().fetchClickUpTask('abc123', options)
    expect(Object.keys(store.getState().clickupTaskCache)).toHaveLength(1)
    await store.getState().fetchClickUpTask('abc123', { ...options, force: true })

    expect(store.getState().clickupTaskCache).toEqual({})
  })
})

describe('ClickUp status writes', () => {
  function context(overrides: Partial<TaskSourceContext>): TaskSourceContext {
    return { ...sourceContext('p1'), ...overrides }
  }

  async function cacheOpenTask(
    store: ReturnType<typeof createTestStore>,
    read: { sourceContext: TaskSourceContext },
    statusName = 'Open'
  ) {
    api.getTask.mockResolvedValueOnce(task(statusName))
    api.listTasks.mockResolvedValueOnce({ tasks: [task(statusName)], nextPage: null })
    await store.getState().fetchClickUpTask('abc123', read)
    await store.getState().listClickUpTasks({ filter: ALL, page: 0 }, read)
  }

  function cachedStatuses(
    store: ReturnType<typeof createTestStore>,
    read: { sourceContext: TaskSourceContext }
  ): (string | undefined)[] {
    const state = store.getState()
    return [
      state.clickupTaskCache[clickupTaskCacheKey(state, read.sourceContext, 'abc123')]?.data?.status
        .name,
      state.clickupListCache[
        clickupListCacheKey(state, read.sourceContext, { filter: ALL, page: 0 })
      ]?.data?.tasks[0]?.status.name
    ]
  }

  it('patches every source of the same host and Workspace, and no other host or Workspace', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    const sibling = {
      sourceContext: context({ projectId: 'p2', repoId: 'r1', accountLabel: 'me' })
    }
    const otherHost = { sourceContext: context({ hostId: 'runtime:env-1' }) }
    const otherWorkspace = {
      sourceContext: context({ providerIdentity: { provider: 'clickup', workspaceId: 'B' } })
    }
    const writing = deferred<{ ok: false; error: string }>()
    api.updateTask.mockReturnValue(writing.promise)
    for (const read of [writer, sibling, otherHost, otherWorkspace]) {
      await cacheOpenTask(store, read)
    }

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)

    expect(cachedStatuses(store, writer)).toEqual(['Done', 'Done'])
    expect(cachedStatuses(store, sibling)).toEqual(['Done', 'Done'])
    expect(cachedStatuses(store, otherHost)).toEqual(['Open', 'Open'])
    expect(cachedStatuses(store, otherWorkspace)).toEqual(['Open', 'Open'])
    writing.resolve({ ok: false, error: 'rejected' })
    await update
  })

  it('never patches a Workspace whose id extends the writer Workspace id with ::', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    const hostile = {
      sourceContext: context({ providerIdentity: { provider: 'clickup', workspaceId: 'A::p2' } })
    }
    const writing = deferred<{ ok: false; error: string }>()
    api.updateTask.mockReturnValue(writing.promise)
    for (const read of [writer, hostile]) {
      await cacheOpenTask(store, read)
    }

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)

    expect(cachedStatuses(store, writer)).toEqual(['Done', 'Done'])
    expect(cachedStatuses(store, hostile)).toEqual(['Open', 'Open'])
    writing.resolve({ ok: false, error: 'rejected' })
    await update
  })

  it('keeps the identity of list pages that do not hold the written task', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    const writing = deferred<{ ok: false; error: string }>()
    api.updateTask.mockReturnValue(writing.promise)
    await cacheOpenTask(store, writer)
    const otherPage = { tasks: [{ ...task('Open'), id: 'zzz999' }], nextPage: null }
    api.listTasks.mockResolvedValueOnce(otherPage)
    await store.getState().listClickUpTasks({ filter: ALL, page: 1 }, writer)
    const pageKey = clickupListCacheKey(store.getState(), writer.sourceContext, {
      filter: ALL,
      page: 1
    })
    const before = store.getState().clickupListCache[pageKey]

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)

    expect(cachedStatuses(store, writer)).toEqual(['Done', 'Done'])
    expect(store.getState().clickupListCache[pageKey]).toBe(before)
    writing.resolve({ ok: false, error: 'rejected' })
    await update
  })

  it('rolls back only the copies that still hold the optimistic status', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    const sibling = { sourceContext: context({ projectId: 'p2' }) }
    const writing = deferred<{ ok: false; error: string }>()
    api.updateTask.mockReturnValue(writing.promise)
    for (const read of [writer, sibling]) {
      await cacheOpenTask(store, read)
    }

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    api.getTask.mockResolvedValueOnce(task('In progress'))
    await store.getState().fetchClickUpTask('abc123', { ...sibling, force: true })
    writing.resolve({ ok: false, error: 'rejected' })
    await update

    expect(cachedStatuses(store, writer)).toEqual(['Open', 'Open'])
    expect(cachedStatuses(store, sibling)).toEqual(['In progress', 'Open'])
  })

  it('restores each cached copy to the status it held before the write', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    const sibling = { sourceContext: context({ projectId: 'p2' }) }
    const writing = deferred<{ ok: false; error: string }>()
    api.updateTask.mockReturnValue(writing.promise)
    await cacheOpenTask(store, writer)
    await cacheOpenTask(store, sibling, 'In progress')

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    expect(cachedStatuses(store, sibling)).toEqual(['Done', 'Done'])
    writing.resolve({ ok: false, error: 'rejected' })
    await update

    expect(cachedStatuses(store, writer)).toEqual(['Open', 'Open'])
    expect(cachedStatuses(store, sibling)).toEqual(['In progress', 'In progress'])
  })

  it('reloads a list read that started before a successful write instead of caching the old status', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    await cacheOpenTask(store, writer)
    const earlyRead = deferred<{ tasks: ClickUpTask[]; nextPage: null }>()
    api.listTasks.mockReturnValueOnce(earlyRead.promise)
    const read = store
      .getState()
      .listClickUpTasks({ filter: ALL, page: 0 }, { ...writer, force: true })
    api.updateTask.mockResolvedValue({ ok: true })
    api.getTask.mockResolvedValue(task('Done'))
    api.listTasks.mockResolvedValueOnce({ tasks: [task('Done')], nextPage: null })

    await store.getState().updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    earlyRead.resolve({ tasks: [task('Open')], nextPage: null })
    const page = await read

    expect(page.tasks[0]?.status.name).toBe('Done')
    expect(api.listTasks).toHaveBeenCalledTimes(3)
    expect(cachedStatuses(store, writer)[1]).toBe('Done')
  })

  it('keeps the written status over a read that cached the old one while the write was out', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    await cacheOpenTask(store, writer)
    const writing = deferred<{ ok: true }>()
    api.updateTask.mockReturnValue(writing.promise)
    api.getTask.mockResolvedValue(task('Done'))

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    api.listTasks.mockResolvedValueOnce({ tasks: [task('Open')], nextPage: null })
    await store.getState().listClickUpTasks({ filter: ALL, page: 0 }, { ...writer, force: true })
    expect(cachedStatuses(store, writer)[1]).toBe('Open')
    writing.resolve({ ok: true })
    await update

    expect(cachedStatuses(store, writer)[1]).toBe('Done')
  })

  it('applies the written status to a page first cached with the old one while the write was out', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    api.getTask.mockResolvedValue(task('Done'))
    const writing = deferred<{ ok: true }>()
    api.updateTask.mockReturnValue(writing.promise)

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    api.listTasks.mockResolvedValueOnce({ tasks: [task('Open')], nextPage: null })
    await store.getState().listClickUpTasks({ filter: ALL, page: 0 }, writer)
    expect(cachedStatuses(store, writer)[1]).toBe('Open')
    writing.resolve({ ok: true })
    await update

    expect(cachedStatuses(store, writer)[1]).toBe('Done')
  })

  it('keeps a different status that a page first cached during the write already holds', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    api.getTask.mockResolvedValue(task('Done'))
    const writing = deferred<{ ok: true }>()
    api.updateTask.mockReturnValue(writing.promise)

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    api.listTasks.mockResolvedValueOnce({ tasks: [task('Review')], nextPage: null })
    await store.getState().listClickUpTasks({ filter: ALL, page: 0 }, writer)
    writing.resolve({ ok: true })
    await update

    expect(cachedStatuses(store, writer)[1]).toBe('Review')
  })

  it('leaves a copy that got a different newer status while the write was out', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    await cacheOpenTask(store, writer)
    const writing = deferred<{ ok: true }>()
    api.updateTask.mockReturnValue(writing.promise)
    api.getTask.mockResolvedValue(task('Done'))

    const update = store
      .getState()
      .updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    api.listTasks.mockResolvedValueOnce({ tasks: [task('Review')], nextPage: null })
    await store.getState().listClickUpTasks({ filter: ALL, page: 0 }, { ...writer, force: true })
    writing.resolve({ ok: true })
    await update

    expect(cachedStatuses(store, writer)[1]).toBe('Review')
  })

  it('caches a list read that no write overlapped', async () => {
    const store = createTestStore()
    const writer = { sourceContext: sourceContext('p1') }
    api.updateTask.mockResolvedValue({ ok: true })
    api.getTask.mockResolvedValue(task('Done'))
    await store.getState().updateClickUpTaskStatus(task('Open'), statusOption('Done'), writer)
    api.listTasks.mockResolvedValueOnce({ tasks: [task('Done')], nextPage: null })

    await store.getState().listClickUpTasks({ filter: ALL, page: 0 }, writer)

    expect(api.listTasks).toHaveBeenCalledTimes(1)
    expect(cachedStatuses(store, writer)[1]).toBe('Done')
  })
})
