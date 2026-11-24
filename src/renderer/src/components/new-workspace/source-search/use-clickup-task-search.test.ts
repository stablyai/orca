// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { clickupOwnerContextKey } from '@/store/slices/clickup/clickup-read-coordination'
import { useClickUpTaskSearch } from './use-clickup-task-search'

type StoreFixture = {
  listClickUpTasks: ReturnType<typeof vi.fn>
  searchClickUpTasks: ReturnType<typeof vi.fn>
  clickupStatus: { selectedWorkspaceId: string | null }
  clickupStatusContextKey: string | null
}

const store = vi.hoisted((): StoreFixture => ({
  listClickUpTasks: vi.fn(),
  searchClickUpTasks: vi.fn(),
  clickupStatus: { selectedWorkspaceId: 'W1' },
  clickupStatusContextKey: 'local#0'
}))

vi.mock('@/store', () => ({
  useAppStore: <T>(selector: (state: typeof store) => T): T => selector(store)
}))

function sourceContext(hostId: TaskSourceContext['hostId']): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'clickup',
    projectId: 'p1',
    hostId,
    providerIdentity: { provider: 'clickup', workspaceId: 'W1' }
  }
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

describe('useClickUpTaskSearch', () => {
  it('drops the previous host tasks the moment the source context changes', async () => {
    const hostA = sourceContext('local')
    const hostB = sourceContext('runtime:env-b')
    const hostBRead = new Promise<never>(() => {})
    store.listClickUpTasks.mockImplementation(
      (_args: unknown, options: { sourceContext: TaskSourceContext }) =>
        options.sourceContext.hostId === hostA.hostId
          ? Promise.resolve({ tasks: [task('from-a')], nextPage: null })
          : hostBRead
    )
    const { result, rerender } = renderHook(
      (context: TaskSourceContext) =>
        useClickUpTaskSearch({ enabled: true, sourceContext: context, query: '' }),
      { initialProps: hostA }
    )
    await act(async () => {})
    expect(result.current.tasks.map((item) => item.id)).toEqual(['from-a'])

    rerender(hostB)

    expect(result.current.tasks).toEqual([])
    expect(result.current.loading).toBe(true)
  })

  it('re-reads once the status slot names a new Workspace after a failed read', async () => {
    store.clickupStatusContextKey = clickupOwnerContextKey({ kind: 'local' })
    store.clickupStatus.selectedWorkspaceId = 'W1'
    const composer = { ...sourceContext('local'), providerIdentity: null }
    store.listClickUpTasks
      .mockRejectedValueOnce(new Error('WORKSPACE_CHANGED'))
      .mockResolvedValueOnce({ tasks: [task('after-switch')], nextPage: null })
    const { result, rerender } = renderHook(() =>
      useClickUpTaskSearch({ enabled: true, sourceContext: composer, query: '' })
    )
    await act(async () => {})
    expect(result.current.error).not.toBeNull()

    store.clickupStatus.selectedWorkspaceId = 'W2'
    rerender()
    await act(async () => {})

    expect(result.current.error).toBeNull()
    expect(result.current.tasks.map((item) => item.id)).toEqual(['after-switch'])
  })
})
