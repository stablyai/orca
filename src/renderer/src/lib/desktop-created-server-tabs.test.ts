import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}
// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }
const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key)
})

import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import {
  DESKTOP_CREATED_SERVER_TAB_HOLDS,
  _reloadDesktopCreatedServerTabsForTests,
  _resetDesktopCreatedServerTabsForTests,
  noteDesktopCreatedServerTab
} from './desktop-created-server-tabs'

const ENV = 'web-env-1'
const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const held = (workspace: string, id: string): boolean =>
  DESKTOP_CREATED_SERVER_TAB_HOLDS.isTabHeld(workspace, id)

beforeEach(() => {
  storage.clear()
  _resetDesktopCreatedServerTabsForTests()
})

describe('the desktop-created server tab record', () => {
  it('drops the removed worktree’s ids when the worktree is removed, and only those', async () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
        ]
      }
    })
    noteDesktopCreatedServerTab(ENV, WT1, 'simulator-1')
    noteDesktopCreatedServerTab(ENV, WT2, 'simulator-2')

    const result = await store.getState().removeWorktree({ id: WT1, executionHostId: null })

    expect(result).toEqual({ ok: true })
    expect([held(WT1, 'simulator-1'), held(WT2, 'simulator-2')]).toEqual([false, true])
    // Gone from this desktop's storage too: a reload brings back only the other worktree's.
    expect([...storage.values()].join()).not.toContain('simulator-1')
    _reloadDesktopCreatedServerTabsForTests()
    expect([held(WT1, 'simulator-1'), held(WT2, 'simulator-2')]).toEqual([false, true])
  })
})
