import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('closeTab tombstone recording', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('user close records a tombstone for the closed tab', () => {
    const store = createTestStore()
    const wt = 'wt-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      }
    })

    store.getState().closeTab('tab-1')

    const tombstone = store.getState().closedTerminalTabTombstonesByTabId['tab-1']
    expect(tombstone).toBeDefined()
    expect(tombstone.worktreeId).toBe(wt)
    expect(tombstone.closedAt).toBeGreaterThan(0)
  })

  it('pty-exit close does not record a tombstone', () => {
    const store = createTestStore()
    const wt = 'wt-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: 'tab-1', worktreeId: wt })]
      }
    })

    store.getState().closeTab('tab-1', { reason: 'pty-exit' })

    expect(store.getState().closedTerminalTabTombstonesByTabId['tab-1']).toBeUndefined()
  })
})
