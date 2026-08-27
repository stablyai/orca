import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KanbanMarkStartedResult } from '../../../shared/kanban-types'
import {
  getKanbanTaskIdFromLinkedItem,
  retryKanbanCardUpdate,
  syncKanbanTaskAfterWorkspaceStart
} from './kanban-workspace-start-sync'

const mocks = vi.hoisted(() => ({
  markStarted: vi.fn(),
  toastError: vi.fn(),
  requestRefresh: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({ requestKanbanTaskRefresh: mocks.requestRefresh })
  }
}))

const okResult: KanbanMarkStartedResult = { ok: true, moved: true, commented: true }

beforeEach(() => {
  mocks.markStarted.mockReset().mockResolvedValue(okResult)
  mocks.toastError.mockReset()
  mocks.requestRefresh.mockReset()
  globalThis.window = {
    api: {
      kanban: {
        markStarted: mocks.markStarted
      }
    }
  } as never
})

describe('getKanbanTaskIdFromLinkedItem', () => {
  it('returns the id only for a kanban linked item', () => {
    expect(
      getKanbanTaskIdFromLinkedItem({
        provider: 'kanban',
        kanbanIdentifier: 'K-1'
      })
    ).toBe('K-1')
    expect(
      getKanbanTaskIdFromLinkedItem({
        provider: 'github',
        kanbanIdentifier: undefined
      })
    ).toBeNull()
    expect(getKanbanTaskIdFromLinkedItem(null)).toBeNull()
  })
})

describe('syncKanbanTaskAfterWorkspaceStart', () => {
  it('does not call markStarted for a non-Kanban linked item', async () => {
    await syncKanbanTaskAfterWorkspaceStart({
      linkedWorkItem: { provider: 'github', kanbanIdentifier: undefined },
      projectName: 'Widgets',
      branch: 'feature-x'
    })
    expect(mocks.markStarted).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('calls markStarted with the linked task and workspace data after a successful start', async () => {
    await syncKanbanTaskAfterWorkspaceStart({
      linkedWorkItem: { provider: 'kanban', kanbanIdentifier: 'K-1' },
      projectName: 'Widgets',
      branch: 'feature-x'
    })
    expect(mocks.markStarted).toHaveBeenCalledWith({
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: 'feature-x',
      retry: 'all'
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('shows a persistent toast with the retry label on partial failure', async () => {
    mocks.markStarted.mockResolvedValue({
      ok: false,
      moved: true,
      commented: false,
      retry: 'comment-only',
      code: 'server',
      message: 'Comment failed'
    })
    await syncKanbanTaskAfterWorkspaceStart({
      linkedWorkItem: { provider: 'kanban', kanbanIdentifier: 'K-1' },
      projectName: 'Widgets',
      branch: 'feature-x'
    })
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    const [message, options] = mocks.toastError.mock.calls[0]
    expect(String(message)).toContain('обновить карточку')
    expect(options?.action?.label).toBe('Повторить обновление карточки')
    expect(options?.duration).toBe(Infinity)
  })

  it('retries with comment-only when the move already succeeded', async () => {
    mocks.markStarted.mockResolvedValue({
      ok: false,
      moved: true,
      commented: false,
      retry: 'comment-only',
      code: 'server',
      message: 'Comment failed'
    })
    await syncKanbanTaskAfterWorkspaceStart({
      linkedWorkItem: { provider: 'kanban', kanbanIdentifier: 'K-1' },
      projectName: 'Widgets',
      branch: 'feature-x'
    })
    const [, options] = mocks.toastError.mock.calls[0]
    mocks.markStarted.mockResolvedValue(okResult)
    options.action.onClick()
    expect(mocks.markStarted).toHaveBeenLastCalledWith({
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: 'feature-x',
      retry: 'comment-only'
    })
  })

  it('never throws when markStarted rejects', async () => {
    mocks.markStarted.mockRejectedValue(new Error('network down'))
    await expect(
      syncKanbanTaskAfterWorkspaceStart({
        linkedWorkItem: { provider: 'kanban', kanbanIdentifier: 'K-1' },
        projectName: 'Widgets',
        branch: 'feature-x'
      })
    ).resolves.toBeUndefined()
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed comment-only retry as comment-only across repeated network failures', async () => {
    mocks.markStarted.mockResolvedValueOnce({
      ok: false,
      moved: true,
      commented: false,
      retry: 'comment-only',
      code: 'server',
      message: 'Comment failed'
    })
    await syncKanbanTaskAfterWorkspaceStart({
      linkedWorkItem: { provider: 'kanban', kanbanIdentifier: 'K-1' },
      projectName: 'Widgets',
      branch: 'feature-x'
    })
    const [, firstOptions] = mocks.toastError.mock.calls[0]
    mocks.markStarted.mockResolvedValueOnce({
      ok: false,
      moved: false,
      commented: false,
      retry: 'comment-only',
      code: 'network',
      message: 'Kanban is unreachable. Check your connection.'
    })
    firstOptions.action.onClick()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.markStarted).toHaveBeenLastCalledWith({
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: 'feature-x',
      retry: 'comment-only'
    })
    const [, secondOptions] = mocks.toastError.mock.calls[1]
    secondOptions.action.onClick()
    expect(mocks.markStarted).toHaveBeenLastCalledWith({
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: 'feature-x',
      retry: 'comment-only'
    })
  })

  it('requests a Kanban list refresh only after markStarted succeeds', async () => {
    await syncKanbanTaskAfterWorkspaceStart({
      linkedWorkItem: { provider: 'kanban', kanbanIdentifier: 'K-1' },
      projectName: 'Widgets',
      branch: 'feature-x'
    })
    expect(mocks.requestRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not request a Kanban list refresh when markStarted fails', async () => {
    mocks.markStarted.mockResolvedValue({
      ok: false,
      moved: true,
      commented: false,
      retry: 'comment-only',
      code: 'server',
      message: 'Comment failed'
    })
    await syncKanbanTaskAfterWorkspaceStart({
      linkedWorkItem: { provider: 'kanban', kanbanIdentifier: 'K-1' },
      projectName: 'Widgets',
      branch: 'feature-x'
    })
    expect(mocks.requestRefresh).not.toHaveBeenCalled()
  })
})

describe('retryKanbanCardUpdate', () => {
  it('re-shows the toast when the retry also fails', async () => {
    mocks.markStarted.mockResolvedValue({
      ok: false,
      moved: false,
      commented: false,
      retry: 'all',
      code: 'network',
      message: 'Kanban is unreachable. Check your connection.'
    })
    await retryKanbanCardUpdate('K-1', 'Widgets', 'feature-x', 'all')
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(mocks.markStarted).toHaveBeenCalledWith({
      taskId: 'K-1',
      projectName: 'Widgets',
      branch: 'feature-x',
      retry: 'all'
    })
  })
})