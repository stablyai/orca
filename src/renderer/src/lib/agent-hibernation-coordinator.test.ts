import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { DEFAULT_AGENT_HIBERNATION_IDLE_MS } from './agent-hibernation-planner'
import {
  runAgentHibernationTick,
  startAgentHibernationCoordinator
} from './agent-hibernation-coordinator'
import { setDriverForPty } from './pane-manager/mobile-driver-state'
import { registerVisibleTerminalTab, setForegroundTerminalTabIds } from './foreground-terminal-tabs'
import { recordAgentHibernationPaneOutput } from './agent-hibernation-output-activity'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../runtime/runtime-compatibility-test-fixture'
import {
  deferred,
  entry,
  installEligibleState,
  installRuntimeListResponses,
  layout,
  LEAF,
  mockRuntimeEnvironmentCall,
  NOW,
  resetAgentHibernationCoordinatorFixture,
  runtimeListResult,
  tab
} from './agent-hibernation-coordinator-test-fixture'

const PI_TRANSCRIPT_PATH = join(tmpdir(), 'pi-session-1.jsonl')

afterEach(resetAgentHibernationCoordinatorFixture)

describe('agent sleep coordinator', () => {
  it('hibernates an eligible background worktree after two stable ticks', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
    expect(useAppStore.getState().shutdownWorktreeTerminals).not.toHaveBeenCalled()
  })

  it('hibernates completed Pi after the periodic recovery capture', async () => {
    vi.useFakeTimers()
    const piEntry = {
      ...entry(),
      agentType: 'pi' as const,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-session-1',
        transcriptPath: PI_TRANSCRIPT_PATH
      }
    }
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      agentStatusByPaneKey: { [piEntry.paneKey]: piEntry },
      sleepingAgentSessionsByPaneKey: {
        [piEntry.paneKey]: {
          paneKey: piEntry.paneKey,
          tabId: piEntry.tabId,
          worktreeId: piEntry.worktreeId!,
          agent: 'pi',
          providerSession: piEntry.providerSession,
          prompt: '',
          state: 'working',
          capturedAt: piEntry.updatedAt,
          updatedAt: piEntry.updatedAt,
          origin: 'live'
        }
      }
    })

    const liveRecord = useAppStore.getState().sleepingAgentSessionsByPaneKey[piEntry.paneKey]
    useAppStore.getState().captureAllSleepingAgentSessions('periodic')
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[piEntry.paneKey]).toBe(liveRecord)

    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })
    await vi.advanceTimersByTimeAsync(1000)
    expect(shutdown).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: piEntry.paneKey,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
  })

  it('hibernates an eligible pane when a sibling shell PTY is live', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-shell'] }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
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
    // Why: returning to the tab between the plan and the confirm is the eligibility change this
    // must observe. The active worktree is no longer skipped wholesale, so it is no longer a lever.
    setForegroundTerminalTabIds(['tab-1'])
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not hibernate a foreground terminal tab that is not in the active worktree', async () => {
    vi.useFakeTimers()
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    setForegroundTerminalTabIds(['tab-1'])
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(3000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('does not hibernate a visible mounted terminal tab', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))
    const unregister = registerVisibleTerminalTab('tab-1')

    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 1_000)
    unregister()
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 1_000 + DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1)
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    await runAgentHibernationTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
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

  it('rechecks dispatch settlement before shutdown', async () => {
    vi.useFakeTimers()
    const completed = {
      ...entry(),
      orchestration: {
        taskId: 'task-1',
        dispatchId: 'ctx-1',
        dispatchStatus: 'completed' as const
      }
    }
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      agentStatusByPaneKey: { [completed.paneKey]: completed }
    })
    startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

    await vi.advanceTimersByTimeAsync(1000)
    useAppStore.setState({
      agentStatusByPaneKey: {
        [completed.paneKey]: {
          ...completed,
          orchestration: { ...completed.orchestration, dispatchStatus: 'dispatched' }
        }
      }
    })
    await vi.advanceTimersByTimeAsync(1000)

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('restarts confirmation when a foreground terminal visit refreshes idle state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined))

    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 1_999)
    setForegroundTerminalTabIds(['tab-1'])
    vi.setSystemTime(NOW + 2_000)
    setForegroundTerminalTabIds([])

    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    vi.setSystemTime(NOW + 2_000 + DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1)
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()

    await runAgentHibernationTick()
    await Promise.resolve()
    await Promise.resolve()
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1'
    })
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

  it.each(['wt-bg', 'folder:folder-1'])(
    'hibernates a runtime-backed candidate in %s with fresh liveness and exact PTYs',
    async (worktreeId) => {
      vi.useFakeTimers()
      const result = runtimeListResult(['pty-1'])
      result.terminals[0].worktreeId = worktreeId
      installRuntimeListResponses(result, result, result)
      const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
        settings: {
          experimentalAgentHibernation: true,
          agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
          activeRuntimeEnvironmentId: 'runtime-1'
        } as never,
        folderWorkspaces: [
          {
            id: 'folder-1',
            folderPath: tmpdir(),
            executionHostId: 'runtime:runtime-1'
          }
        ] as never,
        tabsByWorktree: { [worktreeId]: [{ ...tab(), worktreeId }] },
        agentStatusByPaneKey: { [entry().paneKey]: { ...entry(), worktreeId } },
        ptyIdsByTabId: { 'tab-1': [] }
      })
      startAgentHibernationCoordinator({ intervalMs: 1000, now: () => NOW })

      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(1000)

      expect(shutdown).toHaveBeenCalledWith(worktreeId, {
        paneKey: `tab-1:${LEAF}`,
        tabId: 'tab-1',
        leafId: LEAF,
        ptyId: 'pty-1',
        expectedRuntimePtyId: 'pty-1'
      })
      expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'terminal.list',
          params: expect.objectContaining({ requireFreshPtyLiveness: true })
        })
      )
    }
  )

  it('requires fresh runtime liveness for confirmation and pre-shutdown recheck', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-1']),
      runtimeListResult(['pty-shell'])
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

  it('revalidates a confirmed pane without listing unrelated runtime worktrees', async () => {
    installRuntimeListResponses(...Array.from({ length: 3 }, () => runtimeListResult(['pty-1'])))
    const shutdown = installEligibleState(vi.fn().mockResolvedValue(undefined), {
      settings: {
        experimentalAgentHibernation: true,
        agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS,
        activeRuntimeEnvironmentId: 'runtime-1'
      } as never,
      worktreesByRepo: {
        'fixture-repo': [
          {
            id: 'wt-bg',
            repoId: 'fixture-repo',
            hostId: 'runtime:runtime-1',
            runtimeOwnerEnvironmentId: 'runtime-1'
          },
          {
            id: 'wt-unrelated',
            repoId: 'fixture-repo',
            hostId: 'runtime:runtime-2',
            runtimeOwnerEnvironmentId: 'runtime-2'
          }
        ]
      } as never,
      tabsByWorktree: {
        'wt-bg': [tab()],
        'wt-unrelated': [{ ...tab(), id: 'tab-2', worktreeId: 'wt-unrelated' }]
      },
      ptyIdsByTabId: { 'tab-1': [] }
    })

    await runAgentHibernationTick()
    await runAgentHibernationTick()

    expect(shutdown).toHaveBeenCalledTimes(1)
    const listCalls = mockRuntimeEnvironmentCall.mock.calls.filter(
      ([args]) => args.method === 'terminal.list'
    )
    // Both confirmation samples and the destructive recheck query only the completed agent's owner.
    expect(listCalls).toHaveLength(3)
    expect(listCalls.at(-1)?.[0]).toMatchObject({
      selector: 'runtime-1',
      params: { worktree: expect.anything() }
    })
  })

  it('does not request runtime inventories for 100 workspaces without completed agents', async () => {
    installRuntimeListResponses()
    const tabs = Array.from({ length: 100 }, (_, index) => ({
      ...tab(),
      id: `tab-${index}`,
      worktreeId: `wt-${index}`
    }))
    const shutdown = installEligibleState(vi.fn(), {
      worktreesByRepo: {
        'fixture-repo': tabs.map((t) => ({
          id: t.worktreeId,
          repoId: 'fixture-repo',
          hostId: 'runtime:runtime-1',
          runtimeOwnerEnvironmentId: 'runtime-1'
        }))
      } as never,
      tabsByWorktree: Object.fromEntries(tabs.map((t) => [t.worktreeId, [t]])),
      agentStatusByPaneKey: Object.fromEntries(
        tabs.map((t, index) => [
          `${t.id}:${LEAF}`,
          {
            ...entry(),
            tabId: t.id,
            worktreeId: t.worktreeId,
            paneKey: `${t.id}:${LEAF}`,
            state: index % 2 === 0 ? 'working' : 'waiting'
          }
        ])
      )
    })

    await runAgentHibernationTick()

    expect(mockRuntimeEnvironmentCall).not.toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('requires host evidence after a skipped workspace completes during another inventory request', async () => {
    const delayed = deferred<ReturnType<typeof runtimeListResult>>()
    installRuntimeListResponses()
    const respond = mockRuntimeEnvironmentCall.getMockImplementation()!
    mockRuntimeEnvironmentCall.mockImplementation((args: { method: string }) =>
      args.method === 'terminal.list'
        ? delayed.promise.then((result) => ({ id: 'delayed', ok: true, result }))
        : respond(args)
    )
    const first = entry()
    const second = { ...entry(), tabId: 'tab-2', paneKey: `tab-2:${LEAF}`, worktreeId: 'wt-other' }
    const shutdown = installEligibleState(vi.fn(), {
      worktreesByRepo: {
        'fixture-repo': ['wt-bg', 'wt-other'].map((id) => ({
          id,
          repoId: 'fixture-repo',
          hostId: 'runtime:runtime-1',
          runtimeOwnerEnvironmentId: 'runtime-1'
        }))
      } as never,
      tabsByWorktree: {
        'wt-bg': [tab()],
        'wt-other': [{ ...tab(), id: 'tab-2', worktreeId: 'wt-other' }]
      },
      agentStatusByPaneKey: {
        [first.paneKey]: { ...first, state: 'working' },
        [second.paneKey]: second
      }
    })

    const tick = runAgentHibernationTick()
    await vi.waitFor(() =>
      expect(mockRuntimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.list' })
      )
    )
    useAppStore.setState({ agentStatusByPaneKey: { [first.paneKey]: first } })
    delayed.resolve(runtimeListResult([]))
    await tick

    installRuntimeListResponses()
    await runAgentHibernationTick()
    expect(shutdown).not.toHaveBeenCalled()
    await runAgentHibernationTick()
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(shutdown).toHaveBeenCalledWith(
      'wt-bg',
      expect.objectContaining({
        expectedRuntimePtyId: 'pty-1'
      })
    )
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
    setForegroundTerminalTabIds(['tab-1'])
    delayed.resolve(runtimeListResult(['pty-1']))
    await Promise.resolve()

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('hibernates runtime-backed candidates independently when siblings remain live', async () => {
    vi.useFakeTimers()
    installRuntimeListResponses(
      runtimeListResult(['pty-1', 'pty-2']),
      runtimeListResult(['pty-1', 'pty-2']),
      runtimeListResult(['pty-1', 'pty-2']),
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

    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${LEAF}`,
      tabId: 'tab-1',
      leafId: LEAF,
      ptyId: 'pty-1',
      expectedRuntimePtyId: 'pty-1'
    })
    expect(shutdown).toHaveBeenCalledWith('wt-bg', {
      paneKey: `tab-1:${secondLeaf}`,
      tabId: 'tab-1',
      leafId: secondLeaf,
      ptyId: 'pty-2',
      expectedRuntimePtyId: 'pty-2'
    })
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

describe('teardown drains sequentially', () => {
  // Why: each shutdown re-runs a full runtime-liveness sweep and then a stopExact RPC.
  // Firing the whole confirmed set at once meant ~100 concurrent sweeps plus ~100
  // concurrent stops on the first pass after a backlog — hundreds of near-simultaneous
  // RPCs on an SSH runtime.
  it('never runs two pane teardowns at the same time', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const shutdown = vi.fn().mockImplementation(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight -= 1
    })
    const second = '22222222-2222-4222-8222-222222222222'
    const third = '33333333-3333-4333-8333-333333333333'
    const leafIds = [LEAF, second, third]
    const entries = leafIds.map((leafId) => ({ ...entry(), paneKey: `tab-1:${leafId}` }))
    installEligibleState(shutdown, {
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: Object.fromEntries(leafIds.map((id, i) => [id, `pty-${i + 1}`]))
        }
      } as never,
      ptyIdsByTabId: { 'tab-1': leafIds.map((_, i) => `pty-${i + 1}`) },
      agentStatusByPaneKey: Object.fromEntries(entries.map((e) => [e.paneKey, e])) as never
    })

    await runAgentHibernationTick()
    await runAgentHibernationTick()

    expect(shutdown).toHaveBeenCalledTimes(leafIds.length)
    expect(maxInFlight).toBe(1)
  })
})
