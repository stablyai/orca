// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { clickupOwnerContextKey } from '@/store/slices/clickup/clickup-read-coordination'
import { useClickUpUrlSource } from './use-clickup-url-source'
import type { ClickUpSourceConnection } from './use-clickup-source-connection'

type StoreFixture = {
  fetchClickUpTask: ReturnType<typeof vi.fn>
  clickupStatus: { selectedWorkspaceId: string | null }
  clickupStatusContextKey: string | null
}

const store = vi.hoisted((): StoreFixture => ({
  fetchClickUpTask: vi.fn(),
  clickupStatus: { selectedWorkspaceId: 'W1' },
  clickupStatusContextKey: null
}))

vi.mock('@/store', () => ({
  useAppStore: <T>(selector: (state: typeof store) => T): T => selector(store)
}))

const TASK_URL = 'https://app.clickup.com/t/86abc123'

const connection: ClickUpSourceConnection = {
  status: {
    connected: true,
    viewer: { id: 'u1', username: 'ana', email: 'ana@example.com' },
    workspaces: [{ id: 'W1', name: 'Alpha' }],
    selectedWorkspaceId: 'W1'
  },
  loaded: true,
  errorKind: null,
  retry: vi.fn()
}

function context(providerIdentity: TaskSourceContext['providerIdentity']): TaskSourceContext {
  return {
    kind: 'task-source',
    provider: 'clickup',
    projectId: 'p1',
    hostId: 'local',
    providerIdentity
  }
}

function task(): ClickUpTask {
  return {
    id: '86abc123',
    customId: null,
    name: 'Fix the login',
    descriptionMarkdown: '',
    status: { name: 'Open', color: '#888888', type: 'open', orderIndex: 0 },
    priority: null,
    assignees: [],
    creator: null,
    tags: [],
    url: TASK_URL,
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

async function settleLookup(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  store.fetchClickUpTask.mockReset()
  store.fetchClickUpTask.mockResolvedValue(task())
  store.clickupStatusContextKey = clickupOwnerContextKey({ kind: 'local' })
  store.clickupStatus.selectedWorkspaceId = 'W1'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useClickUpUrlSource', () => {
  it('looks the URL up again when the selected Workspace changes under an unbound context', async () => {
    const unbound = context(null)
    const { rerender } = renderHook(() =>
      useClickUpUrlSource({ value: TASK_URL, enabled: true, sourceContext: unbound, connection })
    )
    await settleLookup()
    expect(store.fetchClickUpTask).toHaveBeenCalledTimes(1)

    store.clickupStatus.selectedWorkspaceId = 'W2'
    rerender()
    await settleLookup()

    expect(store.fetchClickUpTask).toHaveBeenCalledTimes(2)
  })

  it('keeps one lookup for a context bound to a Workspace', async () => {
    const bound = context({ provider: 'clickup', workspaceId: 'W1' })
    const { rerender } = renderHook(() =>
      useClickUpUrlSource({ value: TASK_URL, enabled: true, sourceContext: bound, connection })
    )
    await settleLookup()

    store.clickupStatus.selectedWorkspaceId = 'W2'
    rerender()
    await settleLookup()

    expect(store.fetchClickUpTask).toHaveBeenCalledTimes(1)
  })
})
