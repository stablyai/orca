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

const NOW = 10_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'

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
  shutdownWorktreeTerminals = vi.fn()
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
    shutdownWorktreeTerminals: shutdownWorktreeTerminals as never
  })
  return shutdownWorktreeTerminals
}

afterEach(() => {
  resetAgentHibernationCoordinatorForTests()
  resetForegroundTerminalWorktreeIdsForTests()
  resetAgentHibernationOutputActivityForTests()
  hydrateDrivers([])
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
})
