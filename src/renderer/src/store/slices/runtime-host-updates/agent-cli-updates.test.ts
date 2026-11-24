import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CLI_UPDATE_AGENTS } from '../../../../../shared/agent-launch/installation/agent-cli-update'
import { createTestStore } from '../../testing/app-store-test-fixture'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: () => new Promise(() => {})
}))

const LOCAL = { kind: 'local' } as const
const stale = {
  agent: 'claude',
  installedVersion: '1.0.0',
  latestVersion: '2.0.0',
  command: 'claude update',
  runnable: true
}

describe('checkAgentCliUpdatesOnOpen', () => {
  let hour = 0
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    vi.useFakeTimers({ toFake: ['Date'] })
    // Past any interval an earlier test started; the slice keeps its check times per module.
    hour += 1
    vi.setSystemTime(Date.now() + hour * 60 * 60_000)
  })
  afterEach(() => vi.useRealTimers())

  it('asks again within the periodic interval, at most once in ten seconds', async () => {
    callRuntimeRpc.mockResolvedValueOnce({ updates: [stale] })
    const store = createTestStore()
    await store.getState().checkAgentCliUpdates(LOCAL)
    // The user updates Claude Code in a terminal; no finish event comes.
    callRuntimeRpc.mockResolvedValue({ updates: [] })
    vi.setSystemTime(Date.now() + 5_000)
    await store.getState().checkAgentCliUpdatesOnOpen(LOCAL)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)

    vi.setSystemTime(Date.now() + 5_000)
    await store.getState().checkAgentCliUpdatesOnOpen(LOCAL)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    expect(callRuntimeRpc).toHaveBeenLastCalledWith(
      LOCAL,
      'agentCliUpdate.check',
      { agents: AGENT_CLI_UPDATE_AGENTS },
      expect.anything()
    )
    expect(store.getState().agentCliUpdates.get('')?.updates).toEqual([])
    // The periodic check still waits out its own interval after that.
    await store.getState().checkAgentCliUpdates(LOCAL)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  })

  it('joins a check still on its way past the open interval instead of starting another', async () => {
    let answer = (): void => {}
    callRuntimeRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = () => resolve({ updates: [] })
        })
    )
    const store = createTestStore()
    const startup = store.getState().checkAgentCliUpdates(LOCAL)
    vi.setSystemTime(Date.now() + 15_000)
    let opened = false
    const open = store
      .getState()
      .checkAgentCliUpdatesOnOpen(LOCAL)
      .then(() => {
        opened = true
      })
    await Promise.resolve()
    expect(opened).toBe(false)
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    answer()
    await Promise.all([startup, open])
    expect(opened).toBe(true)
  })
})
