import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'
import { useAppStore } from '@/store'
import {
  hydrateRuntimeEnvironmentSshState,
  SSH_STATE_READ_CONCURRENCY
} from './runtime-environment-ssh-state'
import { callRuntimeRpc } from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: vi.fn()
}))

const callRuntimeRpcMock = vi.mocked(callRuntimeRpc)
const TARGET_COUNT = 8

// The hydrator admits the wire state itself, so fixtures stay untyped wire payloads.
function connState(targetId: string): Record<string, unknown> {
  return {
    targetId,
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    providerEpoch: `${targetId}-provider-epoch`,
    connectionGeneration: 1
  }
}

function rpcResult<T>(value: unknown): Promise<T> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callRuntimeRpc is generic in its result; each fixture returns the shape its method's caller reads.
  return Promise.resolve(value as T)
}

function targetIdOf(params: unknown): string {
  return typeof params === 'object' && params !== null && 'targetId' in params
    ? String(params.targetId)
    : ''
}

type HeldRead = { targetId: string; release: () => void }

// Routes calls through the production queue so lane occupancy is the real one.
function installHeldStateReads(pool: RuntimeRpcCallQueuePool, envId: string): HeldRead[] {
  const held: HeldRead[] = []
  const targets = Array.from({ length: TARGET_COUNT }, (_, index) => ({
    id: `ssh-${index}`,
    label: `box ${index}`
  }))
  callRuntimeRpcMock.mockImplementation((_target, method, params) =>
    pool.enqueue(envId, method, () => {
      if (method === 'ssh.listTargetSummaries') {
        return rpcResult({ targets })
      }
      if (method === 'ssh.listRemovedTargetLabels') {
        return rpcResult({ labels: {} })
      }
      const targetId = targetIdOf(params)
      return new Promise<void>((resolve) => {
        held.push({ targetId, release: resolve })
      }).then(() => rpcResult({ state: connState(targetId) }))
    })
  )
  return held
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve()
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  callRuntimeRpcMock.mockReset()
})

describe('remote SSH state reads', () => {
  it('reads several targets at once instead of waiting on each in turn', async () => {
    const envId = 'env-concurrent'
    const held = installHeldStateReads(new RuntimeRpcCallQueuePool(), envId)

    const hydration = hydrateRuntimeEnvironmentSshState(envId)
    await flush()
    expect(held).toHaveLength(SSH_STATE_READ_CONCURRENCY)

    let maxInFlight = held.length
    for (let read = held.shift(); read; read = held.shift()) {
      read.release()
      await flush()
      maxInFlight = Math.max(maxInFlight, held.length)
    }
    await hydration

    expect(maxInFlight).toBe(SSH_STATE_READ_CONCURRENCY)
    const states = useAppStore.getState().sshStateByEnvironment.get(envId)?.connectionStates
    expect(states?.size).toBe(TARGET_COUNT)
  })

  it('leaves foreground capacity for an interactive call while every read is held', async () => {
    const envId = 'env-lane'
    const pool = new RuntimeRpcCallQueuePool()
    const held = installHeldStateReads(pool, envId)

    const hydration = hydrateRuntimeEnvironmentSshState(envId)
    await flush()
    const send = vi.fn(() => Promise.resolve('sent'))
    const sendResult = pool.enqueue(envId, 'terminal.send', send)
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    await expect(sendResult).resolves.toBe('sent')
    for (let read = held.shift(); read; read = held.shift()) {
      read.release()
      await flush()
    }
    await hydration
  })

  it('stops starting reads once the environment is marked stale', async () => {
    const envId = 'env-stale'
    const held = installHeldStateReads(new RuntimeRpcCallQueuePool(), envId)

    const hydration = hydrateRuntimeEnvironmentSshState(envId)
    await flush()
    useAppStore.getState().markEnvironmentSshStateStale(envId)
    for (let read = held.shift(); read; read = held.shift()) {
      read.release()
      await flush()
    }
    await hydration

    const stateReads = callRuntimeRpcMock.mock.calls.filter(
      ([, method]) => method === 'ssh.getState'
    )
    expect(stateReads).toHaveLength(SSH_STATE_READ_CONCURRENCY)
  })
})
