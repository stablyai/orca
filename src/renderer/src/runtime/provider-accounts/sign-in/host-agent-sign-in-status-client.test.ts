import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc }))
vi.mock('../../rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))

const {
  _resetHostAgentSignInReportsForTest,
  precheckHostAgentSignIn,
  readFreshHostAgentSignInReport,
  refreshHostAgentSignInReport
} = await import('./host-agent-sign-in-status-client')

const report = { checkedAt: 1, agents: [{ agent: 'claude', state: 'signedOut' }] }

describe('host agent sign-in pre-check', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rpc.mockReset()
    rpc.mockResolvedValue(report)
    _resetHostAgentSignInReportsForTest()
  })
  afterEach(() => vi.useRealTimers())

  it('asks the host once and reuses the answer for five minutes', async () => {
    precheckHostAgentSignIn('env-1')
    precheckHostAgentSignIn('env-1')
    await vi.waitFor(() => expect(readFreshHostAgentSignInReport('env-1')).toEqual(report))
    expect(rpc).toHaveBeenCalledTimes(1)

    precheckHostAgentSignIn('env-1')
    expect(rpc).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5 * 60_000)
    expect(readFreshHostAgentSignInReport('env-1')).toBeNull()
    precheckHostAgentSignIn('env-1')
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2))
  })

  it('keeps the last answer when a later ask fails, without counting it as fresh', async () => {
    await refreshHostAgentSignInReport('env-1')
    vi.advanceTimersByTime(5 * 60_000)
    rpc.mockRejectedValue(new Error('asleep'))
    await refreshHostAgentSignInReport('env-1')
    expect(readFreshHostAgentSignInReport('env-1')).toBeNull()
  })
})
