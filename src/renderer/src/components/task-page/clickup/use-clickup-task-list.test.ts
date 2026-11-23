// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CacheEntry } from '@/store/github/cache/cache-model'
import { clickupListCacheKey } from '@/store/slices/clickup/clickup-read-coordination'
import type {
  ClickUpConnectionStatus,
  ClickUpTask,
  ClickUpTaskListFilter,
  ClickUpTaskPage
} from '../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { useClickUpTaskList } from './use-clickup-task-list'

type StoreFixture = {
  listClickUpTasks: ReturnType<typeof vi.fn>
  searchClickUpTasks: ReturnType<typeof vi.fn>
  clickupListCache: Record<string, CacheEntry<ClickUpTaskPage>>
  clickupStatus: ClickUpConnectionStatus
  clickupStatusContextKey: string | null
}

const store = vi.hoisted((): StoreFixture => ({
  listClickUpTasks: vi.fn(),
  searchClickUpTasks: vi.fn(),
  clickupListCache: {},
  clickupStatus: { connected: true, viewer: null, workspaces: [], selectedWorkspaceId: 'W1' },
  clickupStatusContextKey: 'local#0'
}))

vi.mock('@/store/index', () => ({
  useAppStore: <T>(selector: (state: typeof store) => T): T => selector(store)
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const ALL: ClickUpTaskListFilter = { scope: 'all', includeClosed: false }
const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'clickup',
  projectId: 'p1',
  hostId: 'local',
  providerIdentity: { provider: 'clickup', workspaceId: 'W1' }
}

function task(id: string): ClickUpTask {
  return {
    id,
    customId: null,
    name: id,
    descriptionMarkdown: '',
    status: { name: 'Open', color: '#888888', type: 'open', orderIndex: 0 },
    priority: null,
    assignees: [],
    creator: null,
    tags: [],
    url: `https://app.clickup.com/t/${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dueAt: null,
    list: { id: 'l1', name: 'Sprint' },
    folder: null,
    spaceId: 's1',
    workspaceId: 'W1',
    parentId: null
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const NOW = 1_800_000_000_000

function cachePage(page: number, result: ClickUpTaskPage): ClickUpTaskPage {
  store.clickupListCache[clickupListCacheKey(store, sourceContext, { filter: ALL, page })] = {
    data: result,
    fetchedAt: NOW
  }
  return result
}

beforeEach(() => {
  // Cache freshness reads the clock; a fixed instant keeps seeded pages fresh on any machine.
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useClickUpTaskList', () => {
  it('drops a load-more page that was requested before a refresh', async () => {
    const latePage = deferred<ClickUpTaskPage>()
    store.listClickUpTasks.mockImplementation((args: { page: number }) => {
      if (args.page === 1) {
        return latePage.promise
      }
      return Promise.resolve(cachePage(0, { tasks: [task('fresh-0')], nextPage: 1 }))
    })
    cachePage(0, { tasks: [task('stale-0')], nextPage: 1 })
    const { result } = renderHook(() =>
      useClickUpTaskList({ enabled: true, sourceContext, filter: ALL, query: '' })
    )
    await act(async () => {})

    let loadingMore!: Promise<void>
    act(() => {
      loadingMore = result.current.loadMoreClickUpTasks()
    })
    act(() => result.current.refreshClickUpTasks())
    await act(async () => {})
    await act(async () => {
      latePage.resolve(cachePage(1, { tasks: [task('late-1')], nextPage: null }))
      await loadingMore
    })

    expect(result.current.clickupTasks.map((item) => item.id)).toEqual(['fresh-0'])
    expect(result.current.clickupNextPage).toBe(1)
  })

  it('appends a load-more page when no refresh intervened', async () => {
    store.listClickUpTasks.mockImplementation((args: { page: number }) =>
      Promise.resolve(
        args.page === 1
          ? cachePage(1, { tasks: [task('page-1')], nextPage: null })
          : cachePage(0, { tasks: [task('page-0')], nextPage: 1 })
      )
    )
    store.clickupListCache = {}
    const { result } = renderHook(() =>
      useClickUpTaskList({ enabled: true, sourceContext, filter: ALL, query: '' })
    )
    await act(async () => {})

    await act(async () => {
      await result.current.loadMoreClickUpTasks()
    })

    expect(result.current.clickupTasks.map((item) => item.id)).toEqual(['page-0', 'page-1'])
  })
})
