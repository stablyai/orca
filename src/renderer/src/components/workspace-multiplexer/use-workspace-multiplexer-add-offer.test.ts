// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { toast, type Action } from 'sonner'
import { requestWorkspaceMultiplexerAdd } from './workspace-multiplexer-add-request'
import { useWorkspaceMultiplexerAddOffer } from './use-workspace-multiplexer-add-offer'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'

const state = vi.hoisted(() => ({
  activeView: 'multiplexer',
  worktreeLineageById: {} as Record<
    string,
    { origin: string; createdAt: number; worktreeInstanceId: string }
  >,
  workspaceMultiplexer: { slots: [] },
  getKnownWorktreeById: (id: string) => ({
    instanceId: 'instance',
    createdAt: id === 'no-parent' ? Date.now() : undefined
  })
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (value: typeof state) => unknown) => select(state), {
    getState: () => state
  })
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({
  toast: Object.assign(
    vi.fn(() => 'offer'),
    { dismiss: vi.fn() }
  )
}))
vi.mock('./workspace-multiplexer-add-request', () => ({ requestWorkspaceMultiplexerAdd: vi.fn() }))
vi.mock('./workspace-multiplexer-model', () => ({ workspaceMultiplexerSlotIdentity: () => '' }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  state.worktreeLineageById = {}
})

it('asks before adding, batches arrivals, and does not ask again after Later', () => {
  const { rerender } = renderHook(({ catalog }) => useWorkspaceMultiplexerAddOffer(catalog), {
    initialProps: { catalog: [] as WorkspaceMultiplexerCatalogItem[] }
  })
  const row = (id: string): WorkspaceMultiplexerCatalogItem => ({
    identity: id,
    worktreeId: id,
    workspaceName: id,
    executionHostId: 'ssh:box',
    projectIdentity: 'project',
    projectName: 'project',
    projectGroupName: null,
    projectBadgeColor: null,
    workspaceKind: 'worktree',
    branch: id,
    isMainWorktree: false,
    workspaceStatus: undefined,
    review: null,
    path: `/repo/${id}`,
    hostLabel: null
  })
  state.worktreeLineageById = {
    one: { origin: 'orchestration', createdAt: Date.now(), worktreeInstanceId: 'instance' },
    two: { origin: 'cli', createdAt: Date.now(), worktreeInstanceId: 'instance' },
    old: { origin: 'orchestration', createdAt: 1, worktreeInstanceId: 'instance' },
    stale: { origin: 'orchestration', createdAt: Date.now(), worktreeInstanceId: 'old-instance' }
  }
  rerender({ catalog: ['one', 'two', 'old', 'stale', 'no-parent'].map(row) })
  expect(requestWorkspaceMultiplexerAdd).not.toHaveBeenCalled()
  const options = vi.mocked(toast).mock.calls.at(-1)?.[1]
  expect(options?.description).toBe('one, two, no-parent')
  const cancel = options?.cancel as Action
  cancel.onClick({} as Parameters<Action['onClick']>[0])
  vi.mocked(toast).mockClear()
  rerender({ catalog: ['one', 'two'].map(row) })
  expect(toast).not.toHaveBeenCalled()
  state.worktreeLineageById.three = {
    origin: 'orchestration',
    createdAt: Date.now(),
    worktreeInstanceId: 'instance'
  }
  rerender({ catalog: ['one', 'two', 'three'].map(row) })
  const action = vi.mocked(toast).mock.calls.at(-1)?.[1]?.action as Action
  action.onClick({} as Parameters<Action['onClick']>[0])
  expect(requestWorkspaceMultiplexerAdd).toHaveBeenCalledExactlyOnceWith({
    worktreeId: 'three',
    executionHostId: 'ssh:box'
  })
})
