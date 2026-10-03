import { describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { createTestStore, seedStore } from '../slices/store-test-helpers'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

function terminalTab(id: string, worktreeId: string, overrides: Partial<TerminalTab> = {}) {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  } satisfies TerminalTab
}

function seededStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedStore(store, {
    tabsByWorktree: {
      'wt-1': [terminalTab('coordinator', 'wt-1'), terminalTab('worker', 'wt-1')],
      'wt-2': [terminalTab('other', 'wt-2')]
    }
  })
  return store
}

function flagOf(store: ReturnType<typeof createTestStore>, worktreeId: string, tabId: string) {
  return store.getState().tabsByWorktree[worktreeId].find((tab) => tab.id === tabId)?.neverHibernate
}

describe('setTabNeverHibernate', () => {
  it('marks only the addressed tab', () => {
    const store = seededStore()

    store.getState().setTabNeverHibernate('coordinator', true)

    expect(flagOf(store, 'wt-1', 'coordinator')).toBe(true)
    expect(flagOf(store, 'wt-1', 'worker')).toBeUndefined()
    expect(flagOf(store, 'wt-2', 'other')).toBeUndefined()
  })

  it('removes the key again when turned off, restoring the never-opted-in shape', () => {
    const store = seededStore()
    store.getState().setTabNeverHibernate('coordinator', true)

    store.getState().setTabNeverHibernate('coordinator', false)

    const row = store.getState().tabsByWorktree['wt-1'].find((tab) => tab.id === 'coordinator')
    expect(row).toBeDefined()
    expect(Object.hasOwn(row!, 'neverHibernate')).toBe(false)
  })

  it('leaves state identity untouched when the flag already has that value', () => {
    const store = seededStore()
    const before = store.getState().tabsByWorktree

    store.getState().setTabNeverHibernate('coordinator', false)
    expect(store.getState().tabsByWorktree).toBe(before)

    store.getState().setTabNeverHibernate('coordinator', true)
    const enabled = store.getState().tabsByWorktree
    store.getState().setTabNeverHibernate('coordinator', true)
    expect(store.getState().tabsByWorktree).toBe(enabled)
  })

  it('ignores an unknown tab id', () => {
    const store = seededStore()
    const before = store.getState().tabsByWorktree

    store.getState().setTabNeverHibernate('missing', true)

    expect(store.getState().tabsByWorktree).toBe(before)
  })
})
