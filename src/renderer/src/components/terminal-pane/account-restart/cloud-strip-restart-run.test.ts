// RA-11 Restart end to end through the real store: the strip's click queues a Claude restart on a
// pane whose signed-out Claude reports 'blocked' (which the account-restart path reads as mid-turn),
// the mounted pane's runner relaunches it in place, and the strip learns the outcome.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { resetCloudRunningSignoutForTest } from '@/lib/orca-cloud/cloud-running-agent-signout'
import {
  beginCloudAgentRestart,
  CLOUD_AGENT_RESTART_TIMEOUT_MS,
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
    const handleRestartPane = vi.fn(() => order.push('reconnect'))
    runReadyPaneAccountRestarts({
      panes: [{ id: 7, leafId: LEAF }],
      ptyIdOf: () => REMOTE,
      readyRestartPtyIds: selectReadyAccountRestartPtyIds(useAppStore.getState(), TAB),
      tabId: TAB,
      consumePendingPaneAccountRestart: useAppStore.getState().consumePendingPaneAccountRestart,
      buildAccountRestartStartup: () => ({
        command: 'claude',
        resumeProviderSession: providerSession
      }),
      handleRestartPane,
      stopRemotePane: async () => {
        order.push('stop')
      },
      resumeRemotePane
    })
    await vi.waitFor(() => expect(handleRestartPane).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['stop', 'resume', 'reconnect'])
    expect(resumeRemotePane).toHaveBeenCalledWith({
      ptyId: REMOTE,
      worktreeId: 'wt-1',
      tabId: TAB,
      leafId: LEAF,
      agent: 'claude',
      providerSession
    })
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

  it('an account-switch restart on a remote pane does not stop the host terminal', () => {
    useAppStore.setState({
      agentStatusByPaneKey: { [PANE_KEY]: { ...entry(TAB, LEAF), state: 'done' } }
    })
    useAppStore.getState().queuePaneAccountRestarts([REMOTE], 'claude')
    const stopRemotePane = vi.fn(() => Promise.resolve())
    const handleRestartPane = runRemote(stopRemotePane)
    expect(stopRemotePane).not.toHaveBeenCalled()
    expect(handleRestartPane).toHaveBeenCalledTimes(1)
  })
})
