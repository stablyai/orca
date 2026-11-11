// RA-11 Restart feedback: "Restarting…" until the relaunched agent reports, "Couldn't restart" when
// nothing relaunched within the timeout. The strip never vanishes without a result.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCloudRunningSignoutForTest } from './cloud-running-agent-signout'
import {
  beginCloudAgentRestart,
  CLOUD_AGENT_RESTART_TIMEOUT_MS,
  cloudAgentRestartAttempt,
  dismissCloudAgentRestart,
  failCloudAgentRestart,
  isForcedCloudAgentRestart,
  noteCloudAgentRestartLaunched,
  settleCloudAgentRestart,
  resetCloudAgentRestartsForTest
} from './cloud-agent-restart-attempt'

const PANE = 'tab:leaf'
const PTY = 'env@@pty-1'

function begin(queue: () => void = () => undefined): void {
  beginCloudAgentRestart(PANE, { agent: 'claude', resumable: true, ptyId: PTY }, queue)
}

describe('Restart attempt (RA-11)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetCloudRunningSignoutForTest()
    resetCloudAgentRestartsForTest()
  })
  afterEach(() => {
    resetCloudRunningSignoutForTest()
    resetCloudAgentRestartsForTest()
    vi.useRealTimers()
  })

  it('shows restarting at once, queues the restart and marks it forced past the mid-turn wait', () => {
    const queue = vi.fn()
    begin(queue)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(cloudAgentRestartAttempt(PANE, 0)).toMatchObject({
      phase: 'restarting',
      launchedAt: null
    })
    expect(isForcedCloudAgentRestart(PTY)).toBe(true)
  })

  it('fails when nothing relaunched within the timeout, and Try again restarts it', () => {
    begin()
    vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS - 1)
    expect(cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('restarting')
    vi.advanceTimersByTime(1)
    expect(cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('failed')
    // The queued-but-stuck restart no longer jumps the mid-turn rule.
    expect(isForcedCloudAgentRestart(PTY)).toBe(false)
    const queue = vi.fn()
    begin(queue)
    expect(queue).toHaveBeenCalledTimes(1)
    expect(cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('restarting')
  })

  it('fails at once when the pane could not build a startup', () => {
    begin()
    failCloudAgentRestart(PTY)
    expect(cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('failed')
    // The timer is gone: a late timeout never flips a later attempt.
    begin()
    vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS - 1)
    expect(cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('restarting')
  })

  it('fails when queueing throws', () => {
    begin(() => {
      throw new Error('boom')
    })
    expect(cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('failed')
  })

  it('settles only after the relaunch ran; then the strip follows the account', () => {
    begin()
    expect(settleCloudAgentRestart(PANE)).toBe(false)
    noteCloudAgentRestartLaunched(PTY, 5)
    expect(cloudAgentRestartAttempt(PANE, 0)).toMatchObject({ phase: 'restarting', launchedAt: 5 })
    expect(isForcedCloudAgentRestart(PTY)).toBe(false)
    expect(settleCloudAgentRestart(PANE)).toBe(true)
    expect(cloudAgentRestartAttempt(PANE, 0)).toBeNull()
    vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS)
    expect(cloudAgentRestartAttempt(PANE, 0)).toBeNull()
  })

  it('a relaunch with no proof (no new PTY) by the timeout is a failure, never a quiet success', () => {
    begin()
    noteCloudAgentRestartLaunched(PTY)
    vi.advanceTimersByTime(CLOUD_AGENT_RESTART_TIMEOUT_MS)
    expect(cloudAgentRestartAttempt(PANE, 0)?.phase).toBe('failed')
  })

  it('ignores launches and failures of other PTYs', () => {
    begin()
    noteCloudAgentRestartLaunched('other')
    failCloudAgentRestart('other')
    expect(cloudAgentRestartAttempt(PANE, 0)).toMatchObject({
      phase: 'restarting',
      launchedAt: null
    })
  })

  it('dismiss clears a failed attempt', () => {
    begin()
    failCloudAgentRestart(PTY)
    dismissCloudAgentRestart(PANE)
    expect(cloudAgentRestartAttempt(PANE, 0)).toBeNull()
  })
})
