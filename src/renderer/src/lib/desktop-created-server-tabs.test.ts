import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
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

import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import {
  DESKTOP_CREATED_SERVER_TAB_HOLDS,
  _reloadDesktopCreatedServerTabsForTests,
  _resetDesktopCreatedServerTabsForTests,
  forgetDesktopCreatedServerTab,
  forgetDesktopCreatedServerTabsOf,
  forgetPublishedServerTabs,
  isDesktopCreatedServerTab,
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
  it('records an id per workspace: one workspace’s publish or removal leaves the other’s', () => {
    noteDesktopCreatedServerTab(ENV, WT1, 'tab-x')
    noteDesktopCreatedServerTab(ENV, WT2, 'tab-x')
    expect([held(WT1, 'tab-x'), held(WT2, 'tab-x')]).toEqual([true, true])

    forgetPublishedServerTabs(WT1, ['tab-x'])
    expect([held(WT1, 'tab-x'), held(WT2, 'tab-x')]).toEqual([false, true])

    noteDesktopCreatedServerTab(ENV, WT1, 'tab-x')
    forgetDesktopCreatedServerTabsOf(WT2)
    expect([held(WT1, 'tab-x'), held(WT2, 'tab-x')]).toEqual([true, false])
  })

  it('forgets a workspace’s every id, and a closed id in any workspace', () => {
    noteDesktopCreatedServerTab(ENV, WT1, 'tab-a')
    noteDesktopCreatedServerTab(ENV, WT1, 'tab-b')
    noteDesktopCreatedServerTab(ENV, WT2, 'tab-c')
    forgetDesktopCreatedServerTabsOf(WT1)
    expect([held(WT1, 'tab-a'), held(WT1, 'tab-b'), held(WT2, 'tab-c')]).toEqual([
      false,
      false,
      true
    ])
    forgetDesktopCreatedServerTab('tab-c')
    expect(held(WT2, 'tab-c')).toBe(false)
  })

  it('names a tab recorded by its entity id by its tab-bar id too', () => {
    noteDesktopCreatedServerTab(ENV, WT1, 'browser-workspace-1')
    const tabs = [{ id: 'tab-bar-1', entityId: 'browser-workspace-1' }]
    expect(isDesktopCreatedServerTab(tabs, WT1, 'tab-bar-1')).toBe(true)
    expect(isDesktopCreatedServerTab(tabs, WT2, 'tab-bar-1')).toBe(false)
  })

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
