// RA-11 Restart end to end through the real store: the strip's click queues a Claude restart on a
// pane whose signed-out Claude reports 'blocked' (which the account-restart path reads as mid-turn),
// the mounted pane's runner relaunches it in place, and the strip learns the outcome.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Which environments count as Orca Cloud in a test (the real check reads the runtime catalog).
const rpc = vi.hoisted(() => {
  const state: { tail: string[]; sends: unknown[] } = { tail: [], sends: [] }
  return state
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_target: unknown, method: string, params: unknown) => {
    if (method === 'terminal.read') {
      return { terminal: { tail: rpc.tail } }
    }
    if (method === 'terminal.send') {
      rpc.sends.push(params)
    }
    return {}
  }
}))
const cloud = vi.hoisted(() => ({ ids: new Set<string>() }))
vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: (id: string) => cloud.ids.has(id)
}))
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { resetCloudRunningSignoutForTest } from '@/lib/orca-cloud/cloud-running-agent-signout'
import {
  beginCloudAgentRestart,
  CLOUD_AGENT_FRESH_NOTICE_MS,
  CLOUD_AGENT_RESTART_TIMEOUT_MS,
  cloudAgentRestartStartedFresh,
  cloudAgentRestartAttempt,
  resetCloudAgentRestartsForTest,
  settleCloudAgentRestart
} from '@/lib/orca-cloud/cloud-agent-restart-attempt'
import { selectReadyAccountRestartPtyIds } from './pane-account-restart-readiness'
import { runReadyPaneAccountRestarts } from './use-ready-pane-account-restarts'

const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY = 'env-1@@pty-1'
const PANE_KEY = makePaneKey(TAB, LEAF)

function seed(state: AgentStatusEntry['state']): void {
  useAppStore.setState({
    pendingPaneAccountRestarts: {},
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: PTY }
      }
    },
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        paneKey: PANE_KEY,
        tabId: TAB,
        state,
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: [],
        agentType: 'claude',
        providerSession: { key: 'session_id', id: 'sess-1' }
      }
    }
  })
}

function clickRestart(): void {
  beginCloudAgentRestart(PANE_KEY, { agent: 'claude', resumable: true, ptyId: PTY }, () =>
    useAppStore.getState().queuePaneAccountRestarts([PTY], 'claude')
  )
}

function runPane(build: (agent: string) => { command: string } | null) {
  const handleRestartPane = vi.fn()
  runReadyPaneAccountRestarts({
    panes: [{ id: 7, leafId: LEAF }],
    ptyIdOf: () => PTY,
    readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
    tabId: TAB,
    consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
    buildAccountRestartStartup: build,
    handleRestartPane
  })
  return handleRestartPane
}

describe('RA-11 Restart through the account-restart runner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetCloudRunningSignoutForTest()
    resetCloudAgentRestartsForTest()
  })
  afterEach(() => {
    resetCloudRunningSignoutForTest()
    resetCloudAgentRestartsForTest()
    useAppStore.setState({ pendingPaneAccountRestarts: {}, agentStatusByPaneKey: {} })
    vi.useRealTimers()
  })

  it('relaunches a blocked Claude in place, with the resume startup, and reports it launched', () => {
    seed('blocked')
    clickRestart()
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('restarting')
    const handleRestartPane = runPane(() => ({ command: 'claude --resume sess-1' }))
    expect(handleRestartPane).toHaveBeenCalledWith(
      7,
      { command: 'claude --resume sess-1' },
      { focus: false }
    )
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({})
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.launchedAt).not.toBeNull()
    // The strip settles it once the pane shows the new PTY (CloudRunningStripPortal).
    expect(settleCloudAgentRestart(PANE_KEY)).toBe(true)
    vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS)
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)).toBeNull()
  })

  it('an account-switch restart (not the strip) still waits out a blocked Claude', () => {
    seed('blocked')
    useAppStore.getState().queuePaneAccountRestarts([PTY], 'claude')
    const handleRestartPane = runPane(() => ({ command: 'claude --resume sess-1' }))
    expect(handleRestartPane).not.toHaveBeenCalled()
    expect(useAppStore.getState().pendingPaneAccountRestarts).toEqual({ [PTY]: 'claude' })
  })

  it('shows the failure at once when the pane has no startup to launch', () => {
    seed('blocked')
    clickRestart()
    const handleRestartPane = runPane(() => null)
    expect(handleRestartPane).not.toHaveBeenCalled()
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('failed')
  })

  it('shows the failure when the startup throws, without breaking the pane', () => {
    seed('blocked')
    clickRestart()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    runPane(() => {
      throw new Error('no claude command')
    })
    warn.mockRestore()
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('failed')
  })

  it('shows the failure after the timeout when no mounted pane ran it', () => {
    seed('blocked')
    clickRestart()
    vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS)
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('failed')
    // And the stale queued restart no longer jumps the mid-turn rule.
    expect(selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB)).toEqual([])
  })
})

// Orca Cloud panes are paired web-host panes: the host already runs a terminal there, so a reconnect
// alone reattaches to the old agent. The restart stops exactly that host terminal first.
describe('RA-11 Restart on a paired (remote) pane', () => {
  const REMOTE = 'remote:env-1@@term_a'
  const OTHER_TAB = 'tab-2'
  const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
  const OTHER = 'remote:env-1@@term_b'
  const tab = (id: string, ptyId: string) => ({
    id,
    ptyId,
    worktreeId: 'wt-1',
    title: 'claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  })
  const entry = (tabId: string, leafId: string): AgentStatusEntry => ({
    paneKey: makePaneKey(tabId, leafId),
    tabId,
    state: 'blocked',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    agentType: 'claude',
    providerSession: { key: 'session_id', id: `sess-${tabId}` }
  })

  beforeEach(() => {
    vi.useFakeTimers()
    resetCloudRunningSignoutForTest()
    resetCloudAgentRestartsForTest()
    useAppStore.setState({
      pendingPaneAccountRestarts: {},
      suppressedPtyExitIds: {},
      tabsByWorktree: { 'wt-1': [tab(TAB, REMOTE), tab(OTHER_TAB, OTHER)] },
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: REMOTE }
        },
        [OTHER_TAB]: {
          root: { type: 'leaf', leafId: OTHER_LEAF },
          activeLeafId: OTHER_LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [OTHER_LEAF]: OTHER }
        }
      },
      agentStatusByPaneKey: {
        [PANE_KEY]: entry(TAB, LEAF),
        [makePaneKey(OTHER_TAB, OTHER_LEAF)]: entry(OTHER_TAB, OTHER_LEAF)
      }
    })
  })
  afterEach(() => {
    resetCloudRunningSignoutForTest()
    resetCloudAgentRestartsForTest()
    useAppStore.setState({ pendingPaneAccountRestarts: {}, agentStatusByPaneKey: {} })
    vi.useRealTimers()
  })

  function clickRemoteRestart(): void {
    beginCloudAgentRestart(PANE_KEY, { agent: 'claude', resumable: true, ptyId: REMOTE }, () =>
      useAppStore.getState().queuePaneAccountRestarts([REMOTE], 'claude')
    )
  }

  function runRemote(stopRemotePane: (ptyId: string, worktreeId: string) => Promise<void>) {
    const handleRestartPane = vi.fn()
    runReadyPaneAccountRestarts({
      panes: [{ id: 7, leafId: LEAF }],
      ptyIdOf: () => REMOTE,
      readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
      tabId: TAB,
      consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
      buildAccountRestartStartup: () => ({ command: 'claude --resume sess-tab-1' }),
      handleRestartPane,
      stopRemotePane
    })
    return handleRestartPane
  }

  it('stops only this pane’s host terminal, then reconnects with the resume startup', async () => {
    clickRemoteRestart()
    const stopRemotePane = vi.fn(() => Promise.resolve())
    const handleRestartPane = runRemote(stopRemotePane)
    // Not before the host confirms the old terminal stopped: else the reconnect reattaches to it.
    expect(handleRestartPane).not.toHaveBeenCalled()
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.launchedAt).toBeNull()
    await vi.waitFor(() => expect(handleRestartPane).toHaveBeenCalledTimes(1))
    expect(stopRemotePane).toHaveBeenCalledTimes(1)
    expect(stopRemotePane).toHaveBeenCalledWith(REMOTE, 'wt-1')
    // The other Claude pane on the same account is untouched and keeps its status.
    expect(stopRemotePane).not.toHaveBeenCalledWith(OTHER, expect.anything())
    expect(
      useAppStore.getState().agentStatusByPaneKey[makePaneKey(OTHER_TAB, OTHER_LEAF)]?.state
    ).toBe('blocked')
    expect(handleRestartPane).toHaveBeenCalledWith(
      7,
      { command: 'claude --resume sess-tab-1' },
      { focus: false }
    )
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.launchedAt).not.toBeNull()
    // Never closes a tab or pane: the same tab and leaf are there after the restart.
    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']?.map((t) => t.id)).toEqual([TAB, OTHER_TAB])
    expect(state.terminalLayoutsByTabId[TAB]?.root).toEqual({ type: 'leaf', leafId: LEAF })
    expect(state.terminalLayoutsByTabId[OTHER_TAB]?.ptyIdsByLeafId).toEqual({ [OTHER_LEAF]: OTHER })
  })

  it('shows the failure and never reconnects when the host terminal could not be stopped', async () => {
    clickRemoteRestart()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const handleRestartPane = runRemote(() =>
      Promise.reject(new Error('terminal_exact_stop_failed'))
    )
    await vi.waitFor(() => expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('failed'))
    warn.mockRestore()
    expect(handleRestartPane).not.toHaveBeenCalled()
    // Its exit suppression is withdrawn, so a later real exit still shows.
    expect(useAppStore.getState().suppressedPtyExitIds[REMOTE]).toBeUndefined()
  })

  it('a resumable pane is relaunched on its own conversation in the same pane, after the stop', async () => {
    clickRemoteRestart()
    const order: string[] = []
    const providerSession = { key: 'session_id' as const, id: 'sess-tab-1' }
    const resumeRemotePane = vi.fn(async () => {
      order.push('resume')
    })
    const freshIfResumeFoundNothing = vi.fn(async () => false)
    const handleRestartPane = vi.fn(() => order.push('reconnect'))
    runReadyPaneAccountRestarts({
      panes: [{ id: 7, leafId: LEAF }],
      ptyIdOf: () => REMOTE,
      readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
      tabId: TAB,
      consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
      buildAccountRestartStartup: () => ({
        command: 'claude',
        resumeProviderSession: providerSession,
        launchConfig: { agentArgs: '--model opus --effort high', agentEnv: {} }
      }),
      handleRestartPane,
      stopRemotePane: async () => {
        order.push('stop')
      },
      resumeRemotePane,
      freshIfResumeFoundNothing,
      buildFreshCommand: (agent, leafId, agentArgs) => `fresh ${agent} ${leafId} ${agentArgs}`
    })
    await vi.waitFor(() => expect(handleRestartPane).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['stop', 'resume', 'reconnect'])
    // RA-11e: after the reconnect, the resume is watched once for "no conversation" (then fresh).
    await vi.waitFor(() => expect(freshIfResumeFoundNothing).toHaveBeenCalledTimes(1))
    expect(freshIfResumeFoundNothing).toHaveBeenCalledWith(
      expect.objectContaining({
        replacedPtyId: REMOTE,
        // RA-11d: the fallback gets the pane's recorded args too.
        freshCommand: `fresh claude ${LEAF} --model opus --effort high`
      })
    )
    expect(resumeRemotePane).toHaveBeenCalledWith({
      // RA-11d: the pane's own launch rides along to the host.
      launchConfig: { agentArgs: '--model opus --effort high', agentEnv: {} },
      ptyId: REMOTE,
      worktreeId: 'wt-1',
      tabId: TAB,
      leafId: LEAF,
      agent: 'claude',
      providerSession
    })
    // A resume that worked never says it started fresh.
    expect(cloudAgentRestartStartedFresh(PANE_KEY, 0)).toBe(false)
  })

  it('end to end: resume → "No conversation found" → one fresh relaunch → "Started a new conversation." once', async () => {
    const { freshIfResumeFoundNothing: realBackstop } =
      await import('@/lib/orca-cloud/cloud-pane-restart-stop')
    rpc.tail = [
      '$ claude --resume sess-tab-1',
      'No conversation found with session ID: sess-tab-1',
      '$ '
    ]
    rpc.sends = []
    clickRemoteRestart()
    const NEW = 'remote:env-1@@term_new'
    const handleRestartPane = vi.fn(() => {
      // The reconnect binds the pane to its new terminal.
      useAppStore.setState({
        terminalLayoutsByTabId: {
          ...useAppStore.getState().terminalLayoutsByTabId,
          [TAB]: {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: NEW }
          }
        }
      })
    })
    runReadyPaneAccountRestarts({
      panes: [{ id: 7, leafId: LEAF }],
      ptyIdOf: () => REMOTE,
      readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
      tabId: TAB,
      consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
      buildAccountRestartStartup: () => ({
        command: 'claude',
        resumeProviderSession: { key: 'session_id' as const, id: 'sess-tab-1' }
      }),
      handleRestartPane,
      stopRemotePane: () => Promise.resolve(),
      resumeRemotePane: () => Promise.resolve(),
      freshIfResumeFoundNothing: (input) =>
        realBackstop({ ...input, sleep: () => Promise.resolve() }),
      buildFreshCommand: () => 'claude --dangerously-skip-permissions'
    })
    await vi.waitFor(() => expect(cloudAgentRestartStartedFresh(PANE_KEY, 0)).toBe(true))
    expect(rpc.sends).toEqual([
      { terminal: 'term_new', text: 'claude --dangerously-skip-permissions', enter: true }
    ])
    vi.advanceTimersByTime(CLOUD_AGENT_FRESH_NOTICE_MS)
    expect(cloudAgentRestartStartedFresh(PANE_KEY, 0)).toBe(false)
    expect(rpc.sends).toHaveLength(1)
  })

  it('a resume that found no conversation says "Started a new conversation." for 3 s, then clears', async () => {
    clickRemoteRestart()
    const handleRestartPane = vi.fn()
    runReadyPaneAccountRestarts({
      panes: [{ id: 7, leafId: LEAF }],
      ptyIdOf: () => REMOTE,
      readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
      tabId: TAB,
      consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
      buildAccountRestartStartup: () => ({
        command: 'claude',
        resumeProviderSession: { key: 'session_id' as const, id: 'sess-tab-1' }
      }),
      handleRestartPane,
      stopRemotePane: () => Promise.resolve(),
      resumeRemotePane: () => Promise.resolve(),
      freshIfResumeFoundNothing: async () => true,
      buildFreshCommand: () => 'claude'
    })
    await vi.waitFor(() => expect(cloudAgentRestartStartedFresh(PANE_KEY, 0)).toBe(true))
    vi.advanceTimersByTime(CLOUD_AGENT_FRESH_NOTICE_MS)
    expect(cloudAgentRestartStartedFresh(PANE_KEY, 0)).toBe(false)
  })

  it('a failed resume on the host shows the failure and never reconnects', async () => {
    clickRemoteRestart()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const handleRestartPane = vi.fn()
    runReadyPaneAccountRestarts({
      panes: [{ id: 7, leafId: LEAF }],
      ptyIdOf: () => REMOTE,
      readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
      tabId: TAB,
      consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
      buildAccountRestartStartup: () => ({
        command: 'claude',
        resumeProviderSession: { key: 'session_id' as const, id: 'sess-tab-1' }
      }),
      handleRestartPane,
      stopRemotePane: () => Promise.resolve(),
      resumeRemotePane: () => Promise.reject(new Error('agent_session_resume_failed'))
    })
    await vi.waitFor(() => expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('failed'))
    warn.mockRestore()
    expect(handleRestartPane).not.toHaveBeenCalled()
  })

  it('a reconnect that never binds a new PTY fails at the timeout', async () => {
    clickRemoteRestart()
    const handleRestartPane = runRemote(() => Promise.resolve())
    await vi.waitFor(() => expect(handleRestartPane).toHaveBeenCalledTimes(1))
    vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS)
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('failed')
  })

  // RA-11c: an account switch on a paired pane reattached to the old agent and never relaunched.
  it('an account-switch restart on a paired pane stops that host terminal, then reconnects', async () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: { ...entry(TAB, LEAF), state: 'done' } }
    })
    useAppStore.getState().queuePaneAccountRestarts([REMOTE], 'claude')
    const stopRemotePane = vi.fn(() => Promise.resolve())
    const handleRestartPane = runRemote(stopRemotePane)
    expect(handleRestartPane).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(handleRestartPane).toHaveBeenCalledTimes(1))
    expect(stopRemotePane).toHaveBeenCalledWith(REMOTE, 'wt-1')
    expect(stopRemotePane).not.toHaveBeenCalledWith(OTHER, expect.anything())
    // Not Orca Cloud: no strip to show a result on, so nothing is tracked.
    expect(cloudAgentRestartAttempt(PANE_KEY, 0)).toBeNull()
  })

  it('on Orca Cloud an account-switch restart is tracked: Restarting…, then proof or a failure', async () => {
    cloud.ids.add('env-1')
    try {
      useAppStore.setState({
        agentStatusByPaneKey: { [PANE_KEY]: { ...entry(TAB, LEAF), state: 'done' } }
      })
      useAppStore.getState().queuePaneAccountRestarts([REMOTE], 'claude')
      const handleRestartPane = runRemote(() => Promise.resolve())
      expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('restarting')
      await vi.waitFor(() => expect(handleRestartPane).toHaveBeenCalledTimes(1))
      expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.launchedAt).not.toBeNull()
      // No new PTY bound by the timeout: a visible failure, never a silent stale pane.
      vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS)
      expect(cloudAgentRestartAttempt(PANE_KEY, 0)?.phase).toBe('failed')
    } finally {
      cloud.ids.clear()
    }
  })

  it('a host that will not stop the terminal shows the reason, and a Codex switch asks again', async () => {
    cloud.ids.add('env-1')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const reopen = vi.spyOn(useAppStore.getState(), 'reopenCodexRestartPrompt')
    try {
      useAppStore.getState().queuePaneAccountRestarts([REMOTE], 'codex')
      const handleRestartPane = vi.fn()
      runReadyPaneAccountRestarts({
        panes: [{ id: 7, leafId: LEAF }],
        ptyIdOf: () => REMOTE,
        readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
        tabId: TAB,
        consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
        buildAccountRestartStartup: () => ({ command: 'codex' }),
        handleRestartPane,
        stopRemotePane: () => Promise.reject(new Error('terminal_exact_stop_failed'))
      })
      await vi.waitFor(() =>
        expect(cloudAgentRestartAttempt(PANE_KEY, 0)).toMatchObject({
          phase: 'failed',
          failure: 'hostUnresponsive'
        })
      )
      expect(handleRestartPane).not.toHaveBeenCalled()
      expect(reopen).toHaveBeenCalledWith(REMOTE)
    } finally {
      warn.mockRestore()
      reopen.mockRestore()
      cloud.ids.clear()
    }
  })
})
