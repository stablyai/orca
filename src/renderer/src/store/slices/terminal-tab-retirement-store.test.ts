import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import {
  TERMINAL_TAB_CLOSE_ACK_MARGIN_MS,
  TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
} from '../../../../shared/terminal-tab-close'

const mockKill = vi.fn().mockResolvedValue(undefined)
const mockRuntimeCall = vi.fn().mockResolvedValue({
  id: 'rpc-1',
  ok: true,
  result: {},
  _meta: { runtimeId: 'local-runtime' }
})
const mockRuntimeEnvironmentCall = vi.fn()
const mockRuntimeEnvironmentSubscribe = vi.fn()

vi.stubGlobal('window', {
  api: {
    pty: { kill: mockKill },
    runtime: { call: mockRuntimeCall },
    runtimeEnvironments: {
      call: mockRuntimeEnvironmentCall,
      subscribe: mockRuntimeEnvironmentSubscribe
    }
  }
})

import {
  capturedPanesByTabId,
  parkedWatchersByTabId
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import {
  createTestStore,
  makeWorktree,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  seedStore
} from './store-test-helpers'
import { replanTerminalTabRetirement } from './terminal-tab-retirement'

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
    mockRuntimeEnvironmentCall.mockReset()
    mockRuntimeEnvironmentSubscribe.mockReset()
    parkedWatchersByTabId.clear()
    capturedPanesByTabId.clear()
  })

  it('retires split, relay, deferred, and pending sessions for a parked tab', async () => {
    const store = createRetirementStore()
    const dispose = vi.fn()
    const siblingRecord = sleepingRecord('tab-2:leaf-2', 'tab-2')
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-primary' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-primary', 'pty-split'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf1: 'pty-primary', leaf2: 'pty-split' }
        }
      },
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'ssh:ssh-1@@relay' },
      deferredSshSessionIdsByTabId: { 'tab-1': 'pty-deferred' },
      pendingReconnectPtyIdByTabId: { 'tab-1': 'pty-pending' },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': sleepingRecord('tab-1:leaf-1', 'tab-1'),
        'legacy-key': sleepingRecord('legacy-key', 'tab-1'),
        'tab-2:leaf-2': siblingRecord
      }
    })
    parkedWatchersByTabId.set('tab-1', {
      worktreeId: 'wt-1',
      tabPtyId: 'pty-primary',
      paneIdByPtyId: new Map([['pty-primary', 1]]),
      disposersByPtyId: new Map([['pty-primary', dispose]])
    })
    capturedPanesByTabId.set('tab-1', { worktreeId: 'wt-1', panes: [] })

    store.getState().closeTab('tab-1')
    await vi.waitFor(() => expect(mockKill).toHaveBeenCalledTimes(5))

    expect(new Set(mockKill.mock.calls.map(([ptyId]) => ptyId))).toEqual(
      new Set(['pty-primary', 'pty-split', 'ssh:ssh-1@@relay', 'pty-deferred', 'pty-pending'])
    )
    expect(store.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(store.getState().deferredSshSessionIdsByTabId['tab-1']).toBeUndefined()
    expect(store.getState().pendingReconnectPtyIdByTabId['tab-1']).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey).toEqual({
      'tab-2:leaf-2': siblingRecord
    })
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-2:leaf-2']).toBe(siblingRecord)
    expect(dispose).toHaveBeenCalledOnce()
    expect(parkedWatchersByTabId.has('tab-1')).toBe(false)
    expect(capturedPanesByTabId.has('tab-1')).toBe(false)
  })

  it('registers teardown that waits for every split PTY kill', async () => {
    const store = createRetirementStore()
    let finishSplitKill!: () => void
    mockKill.mockImplementation((ptyId: string) =>
      ptyId === 'pty-split'
        ? new Promise<void>((resolve) => {
            finishSplitKill = resolve
          })
        : Promise.resolve()
    )
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-primary' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-primary', 'pty-split'] }
    })
    let providerTeardown: Promise<void> | undefined

    store.getState().closeTab('tab-1', {
      registerProviderTeardown: (teardown) => {
        providerTeardown = teardown
      }
    })

    expect(mockKill).toHaveBeenCalledTimes(2)
    expect(providerTeardown).toBeDefined()
    let teardownFinished = false
    void providerTeardown!.then(() => {
      teardownFinished = true
    })
    await Promise.resolve()
    expect(teardownFinished).toBe(false)

    finishSplitKill()
    await providerTeardown
    expect(teardownFinished).toBe(true)
  })

  it('rejects registered teardown when a provider kill fails', async () => {
    const store = createRetirementStore()
    mockKill.mockRejectedValueOnce(new Error('provider unavailable'))
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })
    let providerTeardown: Promise<void> | undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.getState().closeTab('tab-1', {
      registerProviderTeardown: (teardown) => {
        providerTeardown = teardown
      }
    })

    await expect(providerTeardown).rejects.toThrow('terminal_tab_close_failed')
    expect(store.getState().tabsByWorktree['wt-1']).toEqual([])
    warn.mockRestore()
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

  it('uses provider-complete runtime close for registered teardown', async () => {
    const store = createRetirementStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'remote:terminal-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['remote:terminal-1'] }
    })
    let providerTeardown: Promise<void> | undefined

    store.getState().closeTab('tab-1', {
      registerProviderTeardown: (teardown) => {
        providerTeardown = teardown
      }
    })
    await providerTeardown

    expect(mockRuntimeCall).toHaveBeenCalledWith({
      method: 'terminal.closeProvider',
      params: {
        terminal: 'terminal-1',
        timeoutMs: TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
      }
    })
  })

  it('fails closed when a legacy runtime cannot prove provider teardown', async () => {
    const store = createRetirementStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [
          makeTab({
            id: 'tab-1',
            worktreeId: 'wt-1',
            ptyId: 'remote:legacy-runtime@@terminal-1'
          })
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['remote:legacy-runtime@@terminal-1'] }
    })
    const responses = [
      {
        id: 'rpc-close-provider',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method: terminal.closeProvider' },
        _meta: { runtimeId: 'legacy-runtime' }
      },
      {
        id: 'rpc-close',
        ok: true,
        result: { close: { ptyKilled: false } },
        _meta: { runtimeId: 'legacy-runtime' }
      },
      {
        id: 'rpc-wait',
        ok: true,
        result: {
          wait: {
            handle: 'terminal-1',
            condition: 'exit',
            satisfied: true,
            status: 'exited',
            exitCode: null
          }
        },
        _meta: { runtimeId: 'legacy-runtime' }
      }
    ]
    mockRuntimeEnvironmentSubscribe.mockImplementation(
      (_request, callbacks: { onResponse: (response: (typeof responses)[number]) => void }) => {
        const response = responses.shift()!
        queueMicrotask(() => callbacks.onResponse(response))
        return Promise.resolve({ unsubscribe: vi.fn() })
      }
    )
    let providerTeardown: Promise<void> | undefined

    store.getState().closeTab('tab-1', {
      registerProviderTeardown: (teardown) => {
        providerTeardown = teardown
      }
    })
    await expect(providerTeardown).rejects.toThrow(
      'terminal_provider_teardown_requires_runtime_upgrade'
    )

    expect(mockRuntimeEnvironmentSubscribe.mock.calls.map(([request]) => request.method)).toEqual([
      'terminal.closeProvider'
    ])
    expect(mockRuntimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockRuntimeCall).not.toHaveBeenCalled()
  })

  it('preserves shared-owner snapshots while closing the source tab', async () => {
    const store = createRetirementStore()
    const snapshot = { snapshot: 'shared snapshot' }
    const coldRestore = { scrollback: 'shared scrollback', cwd: 'C:\\workspace' }
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-shared' }),
          makeTab({ id: 'tab-2', worktreeId: 'wt-1', ptyId: 'pty-shared' })
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-shared'], 'tab-2': ['pty-shared'] },
      pendingSnapshotByPtyId: { 'pty-shared': snapshot },
      pendingColdRestoreByPtyId: { 'pty-shared': coldRestore }
    })

    store.getState().closeTab('tab-1')
    await Promise.resolve()

    expect(mockKill).not.toHaveBeenCalled()
    expect(store.getState().pendingSnapshotByPtyId['pty-shared']).toBe(snapshot)
    expect(store.getState().pendingColdRestoreByPtyId['pty-shared']).toBe(coldRestore)
  })

  it('fails closed and preserves recovery snapshots for an unroutable live PTY', async () => {
    const store = createRetirementStore()
    const snapshot = { snapshot: 'unroutable snapshot' }
    const coldRestore = { scrollback: 'unroutable scrollback', cwd: '/repo/wt-1' }
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'remote:' })]
      },
      ptyIdsByTabId: { 'tab-1': ['remote:'] },
      pendingSnapshotByPtyId: { 'remote:': snapshot },
      pendingColdRestoreByPtyId: { 'remote:': coldRestore }
    })
    let providerTeardown: Promise<void> | undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.getState().closeTab('tab-1', {
      registerProviderTeardown: (teardown) => {
        providerTeardown = teardown
      }
    })

    await expect(providerTeardown).rejects.toThrow('terminal_tab_close_failed')
    expect(store.getState().pendingSnapshotByPtyId['remote:']).toBe(snapshot)
    expect(store.getState().pendingColdRestoreByPtyId['remote:']).toBe(coldRestore)
    warn.mockRestore()
  })

  it('replans a failed unroutable teardown after its worktree route is repaired', async () => {
    const store = createRetirementStore()
    const worktreeId = 'missing-repo::/repo/repaired'
    seedStore(store, {
      worktreesByRepo: { repo1: [] },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'tab-route-retry', worktreeId, ptyId: 'pty-route-retry' })]
      },
      ptyIdsByTabId: { 'tab-route-retry': ['pty-route-retry'] }
    })
    let providerTeardown: Promise<void> | undefined
    let retryProviderTeardown: (() => Promise<void>) | undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.getState().closeTab('tab-route-retry', {
      registerProviderTeardown: (teardown, retry) => {
        providerTeardown = teardown
        retryProviderTeardown = retry
      }
    })
    await expect(providerTeardown).rejects.toThrow('terminal_tab_close_failed')
    expect(mockKill).not.toHaveBeenCalled()

    store.setState({
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/repo/repaired' })]
      }
    })
    await expect(retryProviderTeardown?.()).resolves.toBeUndefined()

    expect(mockKill).toHaveBeenCalledWith('pty-route-retry', {
      timeoutMs: TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS
    })
    warn.mockRestore()
  })

  it('recomputes the local provider timeout when a failed teardown is retried', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0)
    const store = createRetirementStore()
    mockKill.mockRejectedValueOnce(new Error('provider unavailable')).mockResolvedValue(undefined)
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-deadline', worktreeId: 'wt-1', ptyId: 'pty-deadline' })]
      },
      ptyIdsByTabId: { 'tab-deadline': ['pty-deadline'] }
    })
    let providerTeardown: Promise<void> | undefined
    let retryProviderTeardown: (() => Promise<void>) | undefined
    const deadlineMs = 50_000
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    store.getState().closeTab('tab-deadline', {
      providerTeardownDeadlineMs: deadlineMs,
      registerProviderTeardown: (teardown, retry) => {
        providerTeardown = teardown
        retryProviderTeardown = retry
      }
    })
    await expect(providerTeardown).rejects.toThrow('terminal_tab_close_failed')

    now.mockReturnValue(30_000)
    await expect(retryProviderTeardown?.()).resolves.toBeUndefined()
    expect(mockKill.mock.calls.map(([, options]) => options?.timeoutMs)).toEqual([
      TERMINAL_TAB_PROVIDER_TEARDOWN_TIMEOUT_MS,
      deadlineMs - 30_000 - TERMINAL_TAB_CLOSE_ACK_MARGIN_MS
    ])
    now.mockRestore()
    warn.mockRestore()
  })

  it('retains a prior kill set when a re-materialized tab has no current PTY ids', () => {
    const store = createRetirementStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [
          makeTab({ id: 'tab-replanned', worktreeId: 'wt-1', ptyId: null }),
          makeTab({ id: 'tab-bystander', worktreeId: 'wt-1', ptyId: 'pty-prior' })
        ]
      },
      ptyIdsByTabId: { 'tab-replanned': [], 'tab-bystander': ['pty-prior'] }
    })

    const replanned = replanTerminalTabRetirement(store.getState(), {
      tabId: 'tab-replanned',
      worktreeId: 'wt-1',
      ptyIds: ['pty-prior'],
      localOrSshPtyIds: ['pty-prior'],
      runtimeTerminals: [],
      cleanupOnlyPtyIds: [],
      sharedPtyIds: [],
      unroutablePtyIds: []
    })

    expect(replanned.ptyIds).toEqual(['pty-prior'])
    expect(replanned.sharedPtyIds).toEqual(['pty-prior'])
    expect(replanned.localOrSshPtyIds).toEqual([])
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

  it('does not recreate PTY indexes for a tab that no longer exists', () => {
    const store = createRetirementStore()

    store.getState().updateTabPtyId('closed-tab', 'pty-after-close')

    expect(store.getState().ptyIdsByTabId['closed-tab']).toBeUndefined()
    expect(store.getState().lastKnownRelayPtyIdByTabId['closed-tab']).toBeUndefined()
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

  it('lets a paired host own runtime teardown while pruning local state', async () => {
    const store = createRetirementStore()
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'remote:terminal-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['remote:terminal-1'] }
    })

    store.getState().closeTab('tab-1', { remoteCloseOwnedByHost: true })
    await Promise.resolve()

    expect(mockRuntimeCall).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree['wt-1']).toEqual([])
  })

  it('keeps the tab retired and reports provider rejection without an unhandled promise', async () => {
    const store = createRetirementStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockKill.mockRejectedValueOnce(new Error('provider unavailable'))
    seedStore(store, {
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] }
    })

    store.getState().closeTab('tab-1')
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith('[terminal-retirement] provider teardown failed', {
        tabId: 'tab-1',
        localOrSshFailures: 1,
        runtimeFailures: 0
      })
    )

    expect(store.getState().tabsByWorktree['wt-1']).toEqual([])
    warn.mockRestore()
  })
})
