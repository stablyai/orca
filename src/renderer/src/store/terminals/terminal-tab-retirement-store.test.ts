import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'

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
import { createTestStore, seedStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import { makeTab } from './terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../slices/tabs/tab-group.test-fixture'

function createRetirementStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: 'wt-1', repoId: 'repo1', path: '/repo/wt-1' })]
    }
  })
  return store
}

function sleepingRecord(paneKey: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId,
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  }
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

  it('routes runtime handles to runtime close and preserves shared PTYs', async () => {
    const store = createRetirementStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'remote:terminal-1' }),
          makeTab({ id: 'tab-2', worktreeId: 'wt-1', ptyId: 'pty-shared' })
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:terminal-1', 'pty-shared'],
        'tab-2': ['pty-shared']
      }
    })

    store.getState().closeTab('tab-1')
    await vi.waitFor(() => expect(mockRuntimeCall).toHaveBeenCalled())

    expect(mockRuntimeCall).toHaveBeenCalledWith({
      method: 'terminal.close',
      params: { terminal: 'terminal-1' }
    })
    expect(mockKill).not.toHaveBeenCalled()
  })

  it('reconciles natural exit without issuing teardown or revoking resume authority', async () => {
    const store = createRetirementStore()
    const record = sleepingRecord('tab-1:leaf-1', 'tab-1')
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-dead' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-dead'] },
      sleepingAgentSessionsByPaneKey: { 'tab-1:leaf-1': record }
    })

    store.getState().closeTab('tab-1', { reason: 'pty-exit' })
    await Promise.resolve()

    expect(mockKill).not.toHaveBeenCalled()
    expect(mockRuntimeCall).not.toHaveBeenCalled()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(record)
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
    await vi.waitFor(() => expect(mockKill).toHaveBeenCalledWith('pty-unified-only'))

    expect(store.getState().unifiedTabsByWorktree['wt-1']).toEqual([])
    expect(store.getState().ptyIdsByTabId['terminal-tab-1']).toBeUndefined()
  })
})
