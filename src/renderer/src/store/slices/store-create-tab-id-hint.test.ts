import { describe, it, expect, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createStoreCascadesMockApi()

// Why: CLI-spawned terminals stamp ORCA_PANE_KEY at spawn; renderer must adopt the tab under that id so hook events route correctly.
describe('createTab tabId hint', () => {
  it('treats tab ids as global and rejects hints that collide in another worktree', () => {
    const store = createTestStore()
    const wtA = 'repo1::/path/wt-a'
    const wtB = 'repo1::/path/wt-b'
    const existingId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wtA, repoId: 'repo1', path: '/path/wt-a' }),
          makeWorktree({ id: wtB, repoId: 'repo1', path: '/path/wt-b' })
        ]
      },
      tabsByWorktree: {
        [wtB]: [makeTab({ id: existingId, worktreeId: wtB })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    expect(() => store.getState().createTab(wtA, undefined, undefined, { id: existingId })).toThrow(
      `Terminal tab ${existingId} already exists`
    )
    expect(store.getState().tabsByWorktree[wtA]).toBeUndefined()
  })
})

describe('createTab launchAgent layout', () => {
  it('pins a single-pane layout leaf when creating a launchAgent tab', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-agent'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-agent' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const tab = store.getState().createTab(wt, undefined, undefined, { launchAgent: 'claude' })
    const layout = store.getState().terminalLayoutsByTabId[tab.id]

    expect(layout?.root).toEqual({
      type: 'leaf',
      leafId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
    })
    expect(layout?.activeLeafId).toBe(layout?.root?.type === 'leaf' ? layout.root.leafId : null)
  })
})
