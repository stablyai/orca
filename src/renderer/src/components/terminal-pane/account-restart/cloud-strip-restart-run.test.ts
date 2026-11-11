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
  resetCloudAgentRestartsForTest
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
    // Relaunched: the timeout never turns it into a failure.
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
