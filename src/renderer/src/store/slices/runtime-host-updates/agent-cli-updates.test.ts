import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CLI_UPDATE_AGENTS,
  type AgentCliUpdate
} from '../../../../../shared/agent-launch/installation/agent-cli-update'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { agentCliUpdateHostTarget } from './agent-cli-updates'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))
vi.mock('@/runtime/rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: () => new Promise(() => {})
}))

const LOCAL = { kind: 'local' } as const
const stale: AgentCliUpdate = {
  agent: 'claude',
  installedVersion: '1.0.0',
  latestVersion: '2.0.0',
  command: 'claude update',
  runnable: true
}

const hostStatus = (): RuntimeEnvironmentStatus => ({
  status: createCompatibleRuntimeStatusResponse().result,
  checkedAt: 1
})

const listed = { updates: [stale], runs: {} }

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

describe('forgetAgentCliUpdateHosts', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
  })

  it('drops removed hosts and their late answers and run results, keeping this computer and remaining hosts', async () => {
    const answers: ((value: unknown) => void)[] = []
    callRuntimeRpc.mockImplementation(() => new Promise((resolve) => answers.push(resolve)))
    const store = createTestStore()
    store
      .getState()
      .setRuntimeEnvironments([
        publicRuntimeEnvironment({ id: 'kept' }),
        publicRuntimeEnvironment({ id: 'left' })
      ])
    store.setState({
      agentCliUpdates: new Map([
        ['', listed],
        ['kept', listed]
      ]),
      runtimeStatusByEnvironmentId: new Map([
        ['kept', hostStatus()],
        ['left', hostStatus()]
      ])
    })
    const late = store.getState().checkAgentCliUpdates(agentCliUpdateHostTarget('left'))
    const run = store.getState().runAgentCliUpdate(agentCliUpdateHostTarget('left'), 'claude')
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    store.getState().setRuntimeEnvironments([publicRuntimeEnvironment({ id: 'kept' })])
    answers[0]({ updates: [stale] })
    answers[1]({ ok: false, output: 'failed' })
    await late
    await run
    expect([...store.getState().agentCliUpdates.keys()]).toEqual(['', 'kept'])

    store.getState().setRuntimeEnvironments([])
    expect([...store.getState().agentCliUpdates.keys()]).toEqual([''])
  })

  it('asks a re-paired peer afresh and drops the old peer answer that arrives late', async () => {
    const answers: (() => void)[] = []
    callRuntimeRpc.mockImplementation(
      () =>
        new Promise((resolve) => {
          const updates = answers.length === 0 ? [stale] : []
          answers.push(() => resolve({ updates }))
        })
    )
    const store = createTestStore()
    const connected = new Map([['peer', hostStatus()]])
    store.getState().setRuntimeEnvironments([publicRuntimeEnvironment({ id: 'peer' })])
    store.setState({ runtimeStatusByEnvironmentId: connected })
    const old = store.getState().checkAgentCliUpdates(agentCliUpdateHostTarget('peer'))
    store
      .getState()
      .setRuntimeEnvironments([publicRuntimeEnvironment({ id: 'peer', pairingRevision: 2 })])
    store.setState({ runtimeStatusByEnvironmentId: connected })
    const fresh = store.getState().checkAgentCliUpdates(agentCliUpdateHostTarget('peer'))
    expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
    answers[1]()
    await fresh
    answers[0]()
    await old
    expect(store.getState().agentCliUpdates.has('peer')).toBe(false)
  })
})

describe('runAgentCliUpdate', () => {
  afterEach(() => vi.useRealTimers())

  it('fails a run the host never answers, so the update is not left running', async () => {
    vi.useFakeTimers()
    callRuntimeRpc.mockReset()
    // Local calls carry no timeout of their own: an updater that never exits never answers.
    callRuntimeRpc.mockReturnValue(new Promise(() => {}))
    const store = createTestStore()
    store.setState({ agentCliUpdates: new Map([['', listed]]) })
    const run = store.getState().runAgentCliUpdate(LOCAL, 'claude')
    expect(store.getState().agentCliUpdates.get('')?.runs.claude?.phase).toBe('running')

    await vi.advanceTimersByTimeAsync(3 * 60_000)

    expect(await run).toBe(false)
    expect(store.getState().agentCliUpdates.get('')?.runs.claude?.phase).toBe('failed')
  })
})
