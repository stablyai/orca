import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockKill = vi.fn().mockResolvedValue(undefined)
const mockRuntimeCall = vi.fn().mockResolvedValue({
  id: 'rpc-1',
  ok: true,
  result: {},
  _meta: { runtimeId: 'local-runtime' }
})

vi.stubGlobal('window', {
  api: {
    pty: { kill: mockKill },
    runtime: { call: mockRuntimeCall },
    runtimeEnvironments: { call: vi.fn() }
  }
})

import {
  capturedPanesByTabId,
  parkedWatchersByTabId
} from '@/components/terminal-pane/parking/output-watchers/terminal-parked-watcher-registry'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeWorktree } from '../../slices/worktrees/worktree.test-fixture'

import { makeTabGroup, makeUnifiedTab } from '../../slices/tabs/tab-group.test-fixture'

function createRetirementStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/repo/wt-1' })]
    }
  })
  return store
}

describe('terminal tab retirement store boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockKill.mockResolvedValue(undefined)
    mockRuntimeCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {},
      _meta: { runtimeId: 'local-runtime' }
    })
    parkedWatchersByTabId.clear()
    capturedPanesByTabId.clear()
  })

  it('retires a unified-only terminal instead of removing only its wrapper', async () => {
    const store = createRetirementStore()
    const unified = makeUnifiedTab({
      id: 'unified-tab-1',
      entityId: 'terminal-tab-1',
      worktreeId: 'wt-1',
      groupId: 'group-1'
    })
    seedStore(store, {
      tabsByWorktree: { 'wt-1': [] },
      unifiedTabsByWorktree: { 'wt-1': [unified] },
      groupsByWorktree: {
        'wt-1': [
          makeTabGroup({
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: unified.id,
            tabOrder: [unified.id]
          })
        ]
      },
      ptyIdsByTabId: { 'terminal-tab-1': ['pty-unified-only'] }
    })

    store.getState().closeUnifiedTab(unified.id)

    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([])
    expect(store.getState().ptyIdsByTabId['terminal-tab-1']).toBeUndefined()
  })
})
