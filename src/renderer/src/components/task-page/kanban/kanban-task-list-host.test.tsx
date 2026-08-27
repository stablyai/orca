// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  KanbanConnectionStatus,
  KanbanTaskFilter,
  KanbanTaskListResult,
  KanbanTaskSummary
} from '../../../../../shared/kanban-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
import { useTaskPageKanbanFetch } from '../hooks/use-task-page-kanban-fetch'
import { useTaskPageKanbanListState } from '../hooks/use-task-page-kanban-list-state'
import { KanbanTaskListHost } from './kanban-task-list-host'

const viewer = { id: 'u1', name: 'User One', level: 'admin' }

const executorTask: KanbanTaskSummary = {
  id: 't1',
  title: 'Task one',
  laneId: 'lane-open',
  laneName: 'Открыто',
  due: '2026-08-28',
  urgent: false,
  repositoryUrls: ['https://example.com/org/repo'],
  taskVersion: 1,
  executors: [{ id: 'u1', name: 'User One' }],
  observers: [{ id: 'u2', name: 'User Two' }],
  createdBy: { id: 'u3', name: 'User Three' },
  url: 'https://kanban.fpimi.ru/?task=t1'
}

const executorResult: KanbanTaskListResult = {
  tasks: [executorTask],
  lanes: [{ id: 'lane-open', name: 'Открыто' }],
  receivedAt: '2026-08-27T10:00:00.000Z'
}

const kanbanApi = vi.hoisted(() => ({
  status: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn()
}))

function HostHarness(): React.JSX.Element {
  const {
    kanbanStatus,
    setKanbanStatus,
    kanbanFilter,
    setKanbanFilter,
    setKanbanResult,
    setKanbanLoading,
    setKanbanLoadError,
    kanbanRefreshNonce,
    setKanbanRefreshNonce,
    kanbanSelectedTaskId,
    setKanbanSelectedTaskId,
    setKanbanDetail,
    setKanbanDetailLoading,
    setKanbanDetailError,
    displayedKanbanTasks,
    kanbanListLoadState,
    kanbanDetailState
  } = useTaskPageKanbanListState()

  useTaskPageKanbanFetch({
    taskSource: 'kanban',
    kanbanStatus,
    setKanbanStatus,
    kanbanFilter,
    kanbanRefreshNonce,
    setKanbanRefreshNonce,
    setKanbanResult,
    setKanbanLoading,
    setKanbanLoadError,
    kanbanSelectedTaskId,
    setKanbanDetail,
    setKanbanDetailLoading,
    setKanbanDetailError
  })

  return (
    <>
      <KanbanTaskListHost
        listLoadState={kanbanListLoadState}
        detailState={kanbanDetailState}
        displayedKanbanTasks={displayedKanbanTasks}
        onOpenDetail={(task) => setKanbanSelectedTaskId(task.id)}
        onStartWorkspace={(task) => setKanbanSelectedTaskId(task.id)}
        onRetry={() => undefined}
        onReconnect={() => undefined}
        onCloseDetail={() => setKanbanSelectedTaskId(null)}
        onConnect={() => undefined}
        onHideSource={() => undefined}
      />
      <button type="button" onClick={() => setKanbanFilter({ role: 'observer' })}>
        switch to observer
      </button>
    </>
  )
}

let container: HTMLDivElement | null = null
let root: Root | null = null

function renderHarness(): HTMLDivElement {
  const host = document.createElement('div')
  document.body.appendChild(host)
  container = host
  root = createRoot(host)
  void act(() => {
    root?.render(
      <TooltipProvider>
        <HostHarness />
      </TooltipProvider>
    )
  })
  return host
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  kanbanApi.status.mockReset().mockResolvedValue({ connected: true, viewer })
  kanbanApi.connect.mockReset().mockResolvedValue({ ok: true, viewer })
  kanbanApi.disconnect.mockReset().mockResolvedValue(undefined)
  kanbanApi.listTasks.mockReset().mockResolvedValue(executorResult)
  kanbanApi.getTask.mockReset().mockResolvedValue(null)
  globalThis.window.api = {
    kanban: {
      status: kanbanApi.status,
      connect: kanbanApi.connect,
      disconnect: kanbanApi.disconnect,
      listTasks: kanbanApi.listTasks,
      getTask: kanbanApi.getTask
    }
  } as never
})

afterEach(() => {
  root?.unmount()
  root = null
  container?.remove()
  container = null
})

describe('KanbanTaskListHost rendered regressions', () => {
  it('does not flash the connect empty state before the stored connection resolves', async () => {
    let resolveStatus: (next: KanbanConnectionStatus) => void = () => undefined
    kanbanApi.status.mockImplementation(
      () =>
        new Promise<KanbanConnectionStatus>((resolve) => {
          resolveStatus = resolve
        })
    )
    const host = renderHarness()
    expect(host.textContent).not.toContain('Connect your Kanban')
    expect(host.textContent).not.toContain('Connect Kanban')
    resolveStatus({ connected: true, viewer })
    await flushEffects()
    expect(host.textContent).toContain('Task one')
  })

  it('renders reconnect instead of the list when the list request is rejected with 401/403', async () => {
    kanbanApi.listTasks.mockRejectedValue(
      new Error('Kanban authentication failed. Reconnect your token.')
    )
    const host = renderHarness()
    await flushEffects()
    const reconnectButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Reconnect')
    )
    expect(reconnectButton).not.toBeNull()
    expect(host.textContent).not.toContain('Connect your Kanban')
    expect(host.textContent).not.toContain('Task one')
  })

  it('keeps the previously visible rows with a retry when a filter change request is rejected by the network', async () => {
    kanbanApi.listTasks.mockImplementation((args?: { filter?: KanbanTaskFilter }) => {
      if (args?.filter?.role === 'observer') {
        return Promise.reject(new Error('Kanban is unreachable. Check your connection.'))
      }
      return Promise.resolve(executorResult)
    })
    const host = renderHarness()
    await flushEffects()
    expect(host.textContent).toContain('Task one')

    const switchButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('switch to observer')
    )
    void act(() => {
      switchButton?.click()
    })
    await flushEffects()

    expect(host.textContent).toContain('Task one')
    const retryButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Retry')
    )
    expect(retryButton).not.toBeNull()
    expect(host.textContent).not.toContain('No Kanban tasks found')
  })
})
