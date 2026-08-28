import { describe, it, expect, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

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

createStoreCascadesMockApi()

// Why: CLI-spawned terminals stamp ORCA_PANE_KEY at spawn; renderer must adopt the tab under that id so hook events route correctly.
describe('createTab tabId hint', () => {
  it('uses the supplied id when no collision exists', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-hint'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-hint' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const hintedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const tab = store.getState().createTab(wt, undefined, undefined, { id: hintedId })

    expect(tab.id).toBe(hintedId)
  })

  it('falls back to a fresh id on collision and warns', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-collision'
    const existingId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-collision' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: existingId, worktreeId: wt })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wt, undefined, undefined, { id: existingId })
      expect(tab.id).not.toBe(existingId)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(existingId))
    } finally {
      warn.mockRestore()
    }
  })

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

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wtA, undefined, undefined, { id: existingId })
      expect(tab.id).not.toBe(existingId)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(existingId))
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores empty string hints instead of persisting an unusable tab id', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-empty-hint'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-empty-hint' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wt, undefined, undefined, { id: '' })
      expect(tab.id).not.toBe('')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('ignores web mirror id hints instead of making them canonical host tab ids', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt-web-hint'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt-web-hint' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const hintedId = 'web-terminal-host-tab-1'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const tab = store.getState().createTab(wt, undefined, undefined, { id: hintedId })
      expect(tab.id).not.toBe(hintedId)
      expect(tab.id).not.toMatch(/^web-terminal-/)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
