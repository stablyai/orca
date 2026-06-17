import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from './agent-hibernation-planner'
import {
  resetAgentHibernationCoordinatorForTests,
  startAgentHibernationCoordinator
} from './agent-hibernation-coordinator'
import { hydrateDrivers, setDriverForPty } from './pane-manager/mobile-driver-state'
import {
  resetForegroundTerminalWorktreeIdsForTests,
  setForegroundTerminalWorktreeIds
} from './foreground-terminal-worktrees'
import {
  recordAgentHibernationPaneOutput,
  resetAgentHibernationOutputActivityForTests
} from './agent-hibernation-output-activity'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import type { AppState } from '@/store/types'

const NOW = 10_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'

const mockRuntimeEnvironmentCall = vi.fn()

vi.stubGlobal('window', {
  api: {
    runtimeEnvironments: {
      call: mockRuntimeEnvironmentCall
    }
  }
})

function tab(): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId: 'wt-bg',
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF]: 'pty-1' }
  }
}

function entry(): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'ship it',
    updatedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1,
    stateStartedAt: NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1,
    paneKey: `tab-1:${LEAF}`,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: []
  }
}

function installEligibleState(
  shutdownWorktreeTerminals = vi.fn(),
  overrides: Partial<AppState> = {}
): typeof shutdownWorktreeTerminals {
  const e = entry()
  useAppStore.setState({
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    } as never,
    activeWorktreeId: 'wt-active',
    tabsByWorktree: { 'wt-bg': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    agentStatusByPaneKey: { [e.paneKey]: e },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    shutdownWorktreeTerminals: shutdownWorktreeTerminals as never,
    ...overrides
  })
  return shutdownWorktreeTerminals
}

function runtimeListResult(ptyIds: string[], truncated = false) {
  return {
    terminals: ptyIds.map((ptyId) => ({
      handle: `handle-${ptyId}`,
      ptyId,
      worktreeId: 'wt-bg',
      worktreePath: '/tmp/wt-bg',
      branch: 'feature',
      tabId: `pty:${ptyId}`,
      leafId: `pty:${ptyId}`,
      title: 'Agent',
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: ''
    })),
    totalCount: ptyIds.length,
    truncated
  }
}

function installRuntimeListResponses(
  ...responses: (ReturnType<typeof runtimeListResult> | Error)[]
): void {
  const queue = [...responses]
  mockRuntimeEnvironmentCall.mockImplementation((args: { method: string }) => {
    const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
    if (compatible) {
      return Promise.resolve(compatible)
    }
    if (args.method === 'terminal.list') {
      const response = queue.shift() ?? runtimeListResult(['pty-1'])
      if (response instanceof Error) {
        return Promise.reject(response)
      }
      return Promise.resolve({
        id: 'terminal-list',
        ok: true,
        result: response,
        _meta: { runtimeId: 'runtime-1' }
      })
    }
    return Promise.resolve({
      id: 'default',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-1' }
    })
  })
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

afterEach(() => {
  resetAgentHibernationCoordinatorForTests()
  clearRuntimeCompatibilityCacheForTests()
  resetForegroundTerminalWorktreeIdsForTests()
  resetAgentHibernationOutputActivityForTests()
  hydrateDrivers([])
  mockRuntimeEnvironmentCall.mockReset()
  vi.useRealTimers()
})

describe('agent hibernation coordinator', () => {
  it('hibernates an eligible background worktree after two stable ticks', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      keepIdentifiers: true,
      sleepingPaneKeys: [`tab-1:${LEAF}`]
    })
  })

  it('cancels timers when stopped', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    const stop = startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })
    stop()

    await vi.advanceTimersByTimeAsync(3000)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('revalidates fresh state before shutdown', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.setState({ activeWorktreeId: 'wt-bg' })
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not hibernate a foreground worktree that is not the active worktree', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    setForegroundTerminalWorktreeIds(['wt-bg'])
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(3000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('requires the same candidate signature during final revalidation', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    let nowCalls = 0
    startAgentHibernationCoordinator({
      intervalMs: 1000,
      now: () => {
        nowCalls += 1
        if (nowCalls === 3) {
          const e = entry()
          useAppStore.setState({
            agentStatusByPaneKey: {
              [e.paneKey]: {
                ...e,
                providerSession: { key: 'session_id', id: 'session-2' }
              }
            }
          })
        }
        return NOW
      }
    })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('blocks shutdown when terminal input arrives between confirmation ticks', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.getState().recordTerminalInput(`tab-1:${LEAF}`, NOW)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('blocks shutdown when terminal output arrives between confirmation ticks', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    recordAgentHibernationPaneOutput(`tab-1:${LEAF}`)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not mutate the running coordinator clock on a second start', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })
    startAgentHibernationCoordinator({
      intervalMs: 1000,
      now: () => NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1
    })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalled()
  })

  it('does not hibernate a mobile-driven terminal', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    setDriverForPty('pty-1', { kind: 'mobile', clientId: 'phone-1' })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(3000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('hibernates a runtime-backed candidate with fresh liveness and exact PTYs', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1'])
    )
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      keepIdentifiers: true,
      sleepingPaneKeys: [`tab-1:${LEAF}`],
      expectedRuntimePtyIds: ['pty-1']
    })
    expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ requireFreshPtyLiveness: true })
      })
    )
  })

  it('requires fresh runtime liveness for confirmation and pre-shutdown recheck', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1', 'pty-shell'])
    )
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
    expect(
      mockRuntimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'terminal.list')
    ).toHaveLength(3)
  })

  it('uses fresh store state after awaiting runtime liveness before shutdown', async () => {
    vi.useFakeTimers()
    const delayed = deferred<ReturnType<typeof runtimeListResult>>()
    const responses: (
      | ReturnType<typeof runtimeListResult>
      | Promise<ReturnType<typeof runtimeListResult>>
    )[] = [runtimeListResult(['pty-1']), runtimeListResult(['pty-1']), delayed.promise]
    mockRuntimeEnvironmentCall.mockImplementation((args: { method: string }) => {
      const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
      if (compatible) {
        return Promise.resolve(compatible)
      }
      if (args.method === 'terminal.list') {
        return Promise.resolve(responses.shift() ?? runtimeListResult(['pty-1'])).then(
          (result) => ({
            id: 'terminal-list',
            ok: true,
            result,
            _meta: { runtimeId: 'runtime-1' }
          })
        )
      }
      return Promise.resolve({
        id: 'default',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-1' }
      })
    })
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.setState({ activeWorktreeId: 'wt-bg' })
    delayed.resolve(runtimeListResult(['pty-1']))
    await Promise.resolve()

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('skips runtime-backed candidates with multiple live PTYs', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1', 'pty-2']),
      runtimeListResult(['pty-1', 'pty-2'])
    )
    const secondLeaf = '22222222-2222-4222-8222-222222222222'
    const e = {
      ...entry(),
      paneKey: `tab-1:${secondLeaf}`,
      providerSession: { key: 'session_id' as const, id: 'session-2' }
    }
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...layout(),
          ptyIdsByLeafId: { [LEAF]: 'pty-1', [secondLeaf]: 'pty-2' }
        }
      },
      agentStatusByPaneKey: {
        [`tab-1:${LEAF}`]: entry(),
        [e.paneKey]: e
      }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('fails closed on truncated runtime liveness samples', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(runtimeListResult(['pty-1'], true), runtimeListResult(['pty-1']))
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('fails closed when fresh runtime liveness rejects after an earlier good sample', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(runtimeListResult(['pty-1']), new Error('runtime unavailable'))
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      ptyIdsByTabId: { 'tab-1': [] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
    expect(
      mockRuntimeEnvironmentCall.mock.calls.filter(([args]) => args.method === 'terminal.list')
    ).toHaveLength(2)
  })
})
